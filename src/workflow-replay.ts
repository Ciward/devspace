import type { WorkflowAgentCallRecord } from "./workflow-types.js";
import type {
  WorkflowReplay,
  WorkflowReplayDecision,
  WorkflowReplayHit,
} from "./workflow-api.js";
import type { AgentCacheKeyInput } from "./workflow-types.js";
import { parseJsonText } from "./json-types.js";
import { WorkflowStoredDataError } from "./workflow-errors.js";

/**
 * Resume matcher:
 * 1. Prefer same callIndex + cacheKey
 * 2. On first miss for an index, fall back to consume-once by cacheKey
 *    (handles fan-out reordering vs prior run).
 */
export function createWorkflowReplay(
  priorCalls: WorkflowAgentCallRecord[],
): WorkflowReplay {
  const byIndex = new Map<number, WorkflowAgentCallRecord>();
  const byKeyQueue = new Map<string, WorkflowAgentCallRecord[]>();

  for (const call of priorCalls) {
    if (call.status !== "completed" && call.status !== "from_cache") continue;
    byIndex.set(call.callIndex, call);
    const queue = byKeyQueue.get(call.cacheKey) ?? [];
    queue.push(call);
    byKeyQueue.set(call.cacheKey, queue);
  }

  const consumed = new Set<string>(); // `${callIndex}` of prior rows consumed

  return {
    decide(
      callIndex: number,
      cacheKey: string,
      input: AgentCacheKeyInput,
    ): WorkflowReplayDecision {
      const exact = byIndex.get(callIndex);
      if (exact && exact.cacheKey === cacheKey && !consumed.has(indexKey(exact))) {
        consumed.add(indexKey(exact));
        removeFromKeyQueue(byKeyQueue, exact);
        return { hit: toHit(exact, "same_index") };
      }

      const queue = byKeyQueue.get(cacheKey);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        consumed.add(indexKey(next));
        if (queue.length === 0) byKeyQueue.delete(cacheKey);
        return { hit: toHit(next, "compatible_key") };
      }

      const priorAtIndex = priorCalls.find((call) => call.callIndex === callIndex);
      if (priorAtIndex) {
        if (priorAtIndex.status !== "completed" && priorAtIndex.status !== "from_cache") {
          return { miss: { reason: "prior_call_not_replayable" } };
        }
        if (priorAtIndex.cacheKey !== cacheKey) {
          return {
            miss: {
              reason: "identity_changed",
              changedFields: changedIdentityFields(priorAtIndex, input),
            },
          };
        }
        return { miss: { reason: "compatible_result_consumed" } };
      }

      if (priorCalls.some((call) => call.cacheKey === cacheKey)) {
        return { miss: { reason: "compatible_result_consumed" } };
      }
      return { miss: { reason: "no_compatible_call" } };
    },
  };
}

function indexKey(call: WorkflowAgentCallRecord): string {
  return `${call.runId}:${call.callIndex}`;
}

function removeFromKeyQueue(
  map: Map<string, WorkflowAgentCallRecord[]>,
  call: WorkflowAgentCallRecord,
): void {
  const queue = map.get(call.cacheKey);
  if (!queue) return;
  const idx = queue.findIndex(
    (row) => row.runId === call.runId && row.callIndex === call.callIndex,
  );
  if (idx >= 0) queue.splice(idx, 1);
  if (queue.length === 0) map.delete(call.cacheKey);
}

function toHit(
  call: WorkflowAgentCallRecord,
  replayMatch: WorkflowReplayHit["replayMatch"],
): WorkflowReplayHit {
  const provenance = {
    replayMatch,
    replayedFromRunId: call.runId,
    replayedFromCallIndex: call.callIndex,
  } as const;
  if (call.structuredJson) {
    try {
      return {
        value: parseJsonText(call.structuredJson),
        responseText: call.responseText,
        structuredJson: call.structuredJson,
        providerSessionId: call.providerSessionId,
        ...provenance,
      };
    } catch (cause) {
      throw new WorkflowStoredDataError(
        `${call.runId}.agentCalls[${call.callIndex}].structuredJson`,
        cause,
      );
    }
  }
  return {
    value: call.responseText ?? "",
    responseText: call.responseText,
    structuredJson: call.structuredJson,
    providerSessionId: call.providerSessionId,
    ...provenance,
  };
}

function changedIdentityFields(
  prior: WorkflowAgentCallRecord,
  current: AgentCacheKeyInput,
): Array<keyof AgentCacheKeyInput> {
  const changed: Array<keyof AgentCacheKeyInput> = [];
  if (prior.prompt !== current.prompt) changed.push("prompt");
  if (prior.provider !== current.provider) changed.push("provider");
  if ((prior.model ?? null) !== current.model) changed.push("model");
  if ((prior.effort ?? null) !== current.effort) changed.push("effort");
  const priorSchema = prior.schemaJson ? JSON.stringify(parseJsonText(prior.schemaJson)) : null;
  const currentSchema = current.schema === null ? null : JSON.stringify(current.schema);
  if (priorSchema !== currentSchema) changed.push("schema");
  if (prior.isolation !== current.isolation) changed.push("isolation");
  return changed.length > 0 ? changed : ["prompt"];
}
