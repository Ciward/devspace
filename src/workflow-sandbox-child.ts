import vm from "node:vm";
import { parseWorkflowScript } from "./workflow-script.js";
import type { JsonValue } from "./json-types.js";
import { WORKFLOW_MAX_ITEMS } from "./workflow-types.js";

type SandboxMethod = "agent" | "workflow" | "phase" | "log";

interface StartMessage {
  type: "start";
  source: string;
  filename: string;
  args: JsonValue | undefined;
  budget: {
    total: number | null;
    spent: number;
    remaining: number;
  };
}

interface CallResultMessage {
  type: "call_result";
  id: number;
  value?: unknown;
  error?: SerializedError;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  kind?: string;
}

let nextCallId = 1;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: unknown): void }
>();

process.on("message", (message: StartMessage | CallResultMessage) => {
  if (message.type === "call_result") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(deserializeError(message.error));
    else waiter.resolve(message.value);
    return;
  }
  void execute(message);
});

async function execute(message: StartMessage): Promise<void> {
  try {
    const parsed = parseWorkflowScript(message.source, { filename: message.filename });
    const bridge = (method: SandboxMethod, args: unknown[]): unknown => {
      if (method === "phase" || method === "log") {
        process.send?.({ type: "notify", method, args });
        return undefined;
      }
      const id = nextCallId;
      nextCallId += 1;
      process.send?.({ type: "call", id, method, args });
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    const context = vm.createContext({ __workflowBridge: bridge });
    installContextApi(context, message);
    const factory = parsed.script.runInContext(context, {
      timeout: 5_000,
      displayErrors: true,
    }) as () => Promise<unknown>;
    if (typeof factory !== "function") {
      throw new Error("Workflow script did not compile to a function");
    }
    const value = await factory();
    process.send?.({ type: "result", value }, () => disconnect());
  } catch (error) {
    process.send?.({ type: "error", error: serializeError(error) }, () => disconnect());
  }
}

function installContextApi(context: vm.Context, message: StartMessage): void {
  const bootstrap = `(() => {
    const bridge = globalThis.__workflowBridge;
    delete globalThis.__workflowBridge;

    class WorkflowDeterminismError extends Error {
      constructor(message) {
        super(message);
        this.name = "WorkflowDeterminismError";
      }
    }

    class WorkflowEngineError extends Error {
      constructor(kind, message) {
        super(message);
        this.name = "WorkflowEngineError";
        this.kind = kind;
      }
    }

    Object.defineProperty(Math, "random", {
      configurable: false,
      writable: false,
      value() {
        throw new WorkflowDeterminismError("Math.random() is banned in workflow scripts");
      },
    });

    const RealDate = Date;
    function DateShim(...dateArgs) {
      if (!new.target) {
        throw new WorkflowDeterminismError("Date() is banned in workflow scripts");
      }
      if (dateArgs.length === 0) {
        throw new WorkflowDeterminismError(
          "new Date() without arguments is banned in workflow scripts (pass an ISO string)",
        );
      }
      return Reflect.construct(RealDate, dateArgs, RealDate);
    }
    DateShim.now = () => {
      throw new WorkflowDeterminismError("Date.now() is banned in workflow scripts");
    };
    DateShim.parse = RealDate.parse.bind(RealDate);
    DateShim.UTC = RealDate.UTC.bind(RealDate);
    DateShim.prototype = RealDate.prototype;
    Object.freeze(DateShim);

    const agent = (...callArgs) => bridge("agent", callArgs);
    const workflow = (...callArgs) => bridge("workflow", callArgs);
    const phase = (title) => {
      if (typeof title !== "string" || !title.trim()) {
        throw new WorkflowEngineError("internal", "phase(title) requires a non-empty string");
      }
      return bridge("phase", [title]);
    };
    const log = (...callArgs) => bridge("log", callArgs);
    const parallel = async (tasks) => {
      if (!Array.isArray(tasks)) {
        throw new WorkflowEngineError("internal", "parallel(thunks) requires an array of functions");
      }
      if (tasks.length > ${WORKFLOW_MAX_ITEMS}) {
        throw new WorkflowEngineError(
          "internal",
          "parallel exceeds max items ${WORKFLOW_MAX_ITEMS} (got " + tasks.length + ")",
        );
      }
      return Promise.all(tasks.map(async (task, index) => {
        if (typeof task !== "function") {
          throw new WorkflowEngineError(
            "internal",
            "parallel thunks[" + index + "] must be a function",
          );
        }
        try { return await task(); } catch { return null; }
      }));
    };
    const pipeline = async (items, ...stages) => {
      if (!Array.isArray(items)) {
        throw new WorkflowEngineError(
          "internal",
          "pipeline(items, ...stages) requires an items array",
        );
      }
      if (items.length > ${WORKFLOW_MAX_ITEMS}) {
        throw new WorkflowEngineError(
          "internal",
          "pipeline exceeds max items ${WORKFLOW_MAX_ITEMS} (got " + items.length + ")",
        );
      }
      for (let index = 0; index < stages.length; index += 1) {
        if (typeof stages[index] !== "function") {
          throw new WorkflowEngineError(
            "internal",
            "pipeline stage[" + index + "] must be a function",
          );
        }
      }
      return Promise.all(items.map(async (item, index) => {
        let value = item;
        for (const stage of stages) {
          try { value = await stage(value, item, index); } catch { return null; }
        }
        return value;
      }));
    };
    const args = JSON.parse(${JSON.stringify(JSON.stringify(message.args ?? null))});
    const budget = Object.freeze({
      total: ${JSON.stringify(message.budget.total)},
      spent: () => ${JSON.stringify(message.budget.spent)},
      remaining: () => ${String(message.budget.remaining)},
    });
    const stringifyConsoleArg = (value) => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    const consoleLine = (...callArgs) => log(callArgs.map(stringifyConsoleArg).join(" "));
    const console = Object.freeze({
      log: consoleLine,
      warn: consoleLine,
      error: consoleLine,
      info: consoleLine,
      debug: consoleLine,
    });

    Object.defineProperties(globalThis, {
      agent: { value: Object.freeze(agent), writable: false, configurable: false },
      workflow: { value: Object.freeze(workflow), writable: false, configurable: false },
      phase: { value: Object.freeze(phase), writable: false, configurable: false },
      log: { value: Object.freeze(log), writable: false, configurable: false },
      parallel: { value: Object.freeze(parallel), writable: false, configurable: false },
      pipeline: { value: Object.freeze(pipeline), writable: false, configurable: false },
      args: { value: Object.freeze(args), writable: false, configurable: false },
      budget: { value: budget, writable: false, configurable: false },
      console: { value: console, writable: false, configurable: false },
      Date: { value: DateShim, writable: false, configurable: false },
    });
  })()`;
  vm.runInContext(bootstrap, context, { timeout: 5_000 });
}

function serializeError(error: unknown): SerializedError {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: String(error) };
  }
  const record = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    kind?: unknown;
  };
  return {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : String(error),
    stack: typeof record.stack === "string" ? record.stack : undefined,
    kind: typeof record.kind === "string" ? record.kind : undefined,
  };
}

function deserializeError(input: SerializedError): Error {
  const error = new Error(input.message);
  error.name = input.name;
  if (input.stack) error.stack = input.stack;
  if (input.kind) Object.assign(error, { kind: input.kind });
  return error;
}

function disconnect(): void {
  if (process.connected) process.disconnect?.();
}
