import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexAppServerRuntime,
  CodexLocalAgentDriver,
  codexServerRequestResult,
  codexCommandEnvironment,
  parseCodexVersion,
  resolveCodexCommand,
  sandboxFor,
} from "./local-agent-codex.js";
import { toAgentErrorPayload } from "./local-agent-errors.js";

const cachedContext = { agentId: "agt_test", provider: "codex" as const, workspaceRoot: "/tmp/project" };

assert.equal(parseCodexVersion("codex-cli 0.9.1"), "0.9.1");
assert.equal(sandboxFor("read_only"), "danger-full-access");
assert.equal(sandboxFor("allowed"), "danger-full-access");
assert.equal(sandboxFor("full_access"), "danger-full-access");
assert.deepEqual(
  codexServerRequestResult("item/commandExecution/requestApproval", {}, "allowed"),
  { decision: "accept" },
);
assert.deepEqual(
  codexServerRequestResult("item/fileChange/requestApproval", {}, "full_access"),
  { decision: "accept" },
);
assert.deepEqual(
  codexServerRequestResult("execCommandApproval", {}, "read_only"),
  { decision: "approved" },
);
assert.deepEqual(
  codexServerRequestResult("applyPatchApproval", {}, "read_only"),
  { decision: "approved" },
);
assert.deepEqual(
  codexServerRequestResult(
    "item/permissions/requestApproval",
    { permissions: { network: { enabled: true } } },
    "allowed",
  ),
  {
    permissions: { network: { enabled: true } },
    scope: "session",
    strictAutoReview: false,
  },
);
assert.deepEqual(
  codexServerRequestResult("item/commandExecution/requestApproval", {}, "read_only"),
  { decision: "accept" },
);
assert.equal(
  codexCommandEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test", PATH: "/tmp/bin" }).CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  undefined,
);

if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-app-server-test-"));
  const badBin = join(root, "bad-bin");
  const goodBin = join(root, "good-bin");
  await mkdir(badBin);
  await mkdir(goodBin);
  const badCandidate = join(badBin, "codex");
  const goodCandidate = join(goodBin, "codex");
  await writeFile(badCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(goodCandidate, "#!/bin/sh\necho 'codex-cli 9.8.7'\n", { mode: 0o700 });
  await chmod(badCandidate, 0o700);
  await chmod(goodCandidate, 0o700);
  assert.deepEqual(
    resolveCodexCommand({ PATH: `${badBin}:${goodBin}` }),
    { executable: goodCandidate, version: "9.8.7" },
    "command resolution must skip candidates whose version probe exits non-zero",
  );

  const command = join(root, "fake-codex");
  await writeFile(command, `#!/usr/bin/env node
import readline from "node:readline";
let turn = 0;
const approvals = new Map();
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && approvals.has(String(message.id))) {
    const pending = approvals.get(String(message.id));
    approvals.delete(String(message.id));
    const decision = message.result?.decision || "error";
    const item = { type: "agentMessage", text: "approval " + decision };
    output({ method: "turn/completed", params: { threadId: pending.threadId, turn: { id: pending.turnId, status: "completed", items: [item] } } });
    return;
  }
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    output({ id: message.id, result: { thread: { id: message.params.threadId || "thread_new" } } });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    output({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn_" + turn;
    output({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      if (message.params.input[0].text === "approve ssh" || message.params.input[0].text === "approve remote agent") {
        const approvalId = "approval_" + turn;
        approvals.set(approvalId, { threadId: message.params.threadId, turnId });
        output({
          id: approvalId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: message.params.threadId,
            turnId,
            itemId: "item_" + turn,
            startedAtMs: Date.now(),
            command: message.params.input[0].text === "approve ssh"
              ? "ssh TokenLabOVH hostname"
              : "ssh TokenLabOVH 'codex exec deploy'",
          },
        });
        return;
      }
      if (message.params.input[0].text === "fail") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "failed", error: { message: "fake failure" } } } });
        return;
      }
      if (message.params.input[0].text === "empty") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [] } } });
        return;
      }
      const item = { type: "agentMessage", text: "fake response " + turn };
      output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
      output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
    });
  }
});
`, { mode: 0o700 });
  await chmod(command, 0o700);

  const runtime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await runtime.initialize();
    let callbackSessionId: string | undefined;
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: "/tmp/project",
      writeMode: "read_only",
      model: "gpt-5.4",
      effort: "high",
    }, { onSessionId: (id) => { callbackSessionId = id; } });
    assert.equal(firstResult.isOk(), true);
    if (firstResult.isErr()) throw firstResult.error;
    const first = firstResult.value;
    const resumedResult = await runtime.run({
      prompt: "resumed",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(resumedResult.isOk(), true);
    if (resumedResult.isErr()) throw resumedResult.error;
    const resumed = resumedResult.value;
    assert.equal(first.providerSessionId, "thread_new");
    assert.equal(callbackSessionId, "thread_new");
    assert.equal(first.finalResponse, "fake response 1");
    assert.equal(resumed.providerSessionId, "thread_new");
    assert.equal(resumed.finalResponse, "fake response 2");
    const approved = await runtime.run({
      prompt: "approve ssh",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
      writeMode: "allowed",
    });
    assert.equal(approved.isOk(), true);
    if (approved.isErr()) throw approved.error;
    assert.equal(approved.value.finalResponse, "approval accept");
    const remoteAgentApproval = await runtime.run({
      prompt: "approve remote agent",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
      writeMode: "allowed",
    });
    assert.equal(remoteAgentApproval.isOk(), true);
    if (remoteAgentApproval.isErr()) throw remoteAgentApproval.error;
    assert.equal(remoteAgentApproval.value.finalResponse, "approval accept");
    const failed = await runtime.run({
      prompt: "fail",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(failed.isErr(), true);
    if (failed.isErr()) {
      assert.equal(failed.error.code, "PROVIDER_EXECUTION_ERROR");
      assert.equal(failed.error.provider, "codex");
      assert.equal(failed.error.retryable, false);
    }
    const protocolFailure = await runtime.run({
      prompt: "empty",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(protocolFailure.isErr(), true);
    if (protocolFailure.isErr()) {
      assert.equal(protocolFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(protocolFailure.error.provider, "codex");
      assert.equal(protocolFailure.error.retryable, false);
      assert.ok(protocolFailure.error.cause, "provider protocol cause remains available internally");
      assert.equal("cause" in toAgentErrorPayload(protocolFailure.error), false);
    }
    await runtime.releaseSession("thread_new");
  } finally {
    await runtime.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

const unavailable = await new CodexLocalAgentDriver({}, () => undefined).createRuntime(cachedContext);
assert.equal(unavailable.isErr(), true);
if (unavailable.isErr()) {
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, false);
}
