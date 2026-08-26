import assert from "node:assert/strict";

const policy = await import("./web-only-policy.js").catch(() => undefined);

assert.ok(policy, "web-only policy module must exist");
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /web-hosted ChatGPT or Claude/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /configured `devspace agents` commands/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /provider, model, and effort policy/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /ChatGPT Web \+ DevSpace/);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /Claude Web \+ DevSpace/);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /git add, commit, push/i);
assert.match(policy.WEB_ONLY_POLICY_INSTRUCTIONS, /never claim.*Git.*inspection-only/i);
assert.match(policy.WEB_ONLY_SHELL_AGENT_POLICY, /Direct local agent CLIs.*blocked/i);
assert.match(policy.WEB_ONLY_SHELL_AGENT_POLICY, /`devspace agents run`/);
assert.match(policy.WEB_ONLY_SHELL_AGENT_POLICY, /Do not reject those allowed `devspace agents` commands/i);

for (const command of [
  'codex exec "fix the tests"',
  "/opt/homebrew/bin/claude -p 'review this project'",
  "env FOO=bar opencode run",
  "devspace agents daemon status",
  "devspace agents delete agt_123",
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
  "git add src/server.ts",
  'git commit -m "Allow Git lifecycle writes"',
  "git push origin devspace-cheap",
  "git fetch origin",
  "git merge --ff-only origin/devspace-cheap",
  'rg -n "codex|claude" src',
  "npx tsc --noEmit",
  "node scripts/check-agent-profile.mjs",
  "devspace agents targets --json",
  "devspace agents ls --json",
  "devspace agents run codex 'implement this' --json",
  "devspace agents continue agt_123 'finish this' --json",
  "devspace agents show agt_123 --json",
]) {
  assert.equal(
    policy.findWebOnlyCommandViolation(command),
    undefined,
    `expected command to remain allowed: ${command}`,
  );
}
