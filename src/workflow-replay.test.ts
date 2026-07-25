import assert from "node:assert/strict";
import { createWorkflowReplay } from "./workflow-replay.js";
import type { WorkflowAgentCallRecord } from "./workflow-types.js";

function call(
  partial: Partial<WorkflowAgentCallRecord> &
    Pick<WorkflowAgentCallRecord, "callIndex" | "cacheKey" | "responseText">,
): WorkflowAgentCallRecord {
  return {
    runId: "wfr_prior",
    prompt: "prompt",
    provider: "codex",
    status: "completed",
    fromCache: false,
    isolation: "shared",
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

function identity(prompt = "prompt") {
  return {
    prompt,
    provider: "codex" as const,
    model: null,
    effort: null,
    schema: null,
    isolation: "shared" as const,
  };
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "k0", responseText: "a" }),
    call({ callIndex: 1, cacheKey: "k1", responseText: "b" }),
  ]);
  assert.equal(replay.decide(0, "k0", identity()).hit?.value, "a");
  assert.equal(replay.decide(1, "k1", identity()).hit?.value, "b");
  assert.equal(replay.decide(2, "k0", identity()).miss?.reason, "compatible_result_consumed");
}

{
  // fan-out reorder: callIndex mismatch, consume-once by key
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "ka", responseText: "A" }),
    call({ callIndex: 1, cacheKey: "kb", responseText: "B" }),
  ]);
  // new run asks index0 for kb first
  const reorderedB = replay.decide(0, "kb", identity()).hit;
  assert.equal(reorderedB?.value, "B");
  assert.equal(reorderedB?.replayMatch, "compatible_key");
  assert.equal(replay.decide(1, "ka", identity()).hit?.value, "A");
  assert.equal(
    replay.decide(2, "ka", identity()).miss?.reason,
    "compatible_result_consumed",
  );
}

{
  const replay = createWorkflowReplay([
    call({
      callIndex: 0,
      cacheKey: "ks",
      responseText: '{"ok":true}',
      structuredJson: '{"ok":true}',
    }),
  ]);
  assert.deepEqual(replay.decide(0, "ks", identity()).hit?.value, { ok: true });
}

{
  const replay = createWorkflowReplay([
    call({ callIndex: 0, cacheKey: "old", prompt: "old prompt", responseText: "a" }),
  ]);
  const miss = replay.decide(0, "new", identity("new prompt")).miss;
  assert.equal(miss?.reason, "identity_changed");
  assert.deepEqual(miss?.changedFields, ["prompt"]);
}

console.log("workflow-replay.test.ts: ok");
