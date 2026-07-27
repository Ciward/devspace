import assert from "node:assert/strict";

const policy = await import("./web-only-policy.js").catch(() => undefined);

assert.ok(policy, "web-only policy module must exist");
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /web-hosted ChatGPT or Claude/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /must not consume local agent tokens or quotas/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /ChatGPT Web \+ DevSpace/);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /Claude Web \+ DevSpace/);

for (const command of [
  'codex exec "fix the tests"',
  "/opt/homebrew/bin/claude -p 'review this project'",
  "env FOO=bar opencode run",
  "devspace agents run codex 'implement this'",
  "npx @openai/codex exec",
  "npx @openai/codex@latest exec",
  "npx codex exec",
  "npm exec codex@latest -- exec",
  "pnpm dlx @anthropic-ai/claude-code -p test",
  "bash -lc 'cursor-agent acp'",
  "omx team 3:executor 'fix this'",
  "ask-claude 'review this'",
]) {
  assert.match(
    policy.findWebOnlyCommandViolation(command) ?? "",
    /web-only policy blocks local agent execution/i,
    `expected command to be blocked: ${command}`,
  );
}

for (const command of [
  "npm test",
  "git status --short",
  'rg -n "codex|claude" src',
  "npx tsc --noEmit",
  "node scripts/check-agent-profile.mjs",
]) {
  assert.equal(
    policy.findWebOnlyCommandViolation(command),
    undefined,
    `expected command to remain allowed: ${command}`,
  );
}
