# Strict Codex Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `devspace-cheap` to current upstream and enable only Codex `gpt-5.6-luna` with `max` effort under a non-overridable policy on Mac and DevServer.

**Architecture:** Adopt upstream's daemon-owned Subagent runtime and structured provider configuration, then add one backward-compatible `allowOverrides` policy field enforced during target/profile resolution. Preserve the Web-only boundary by allowing only `devspace agents` as the delegated path. DevServer installs and updates host Codex directly in its persistent home and uses the protected TokenLab `devserver` key.

**Tech Stack:** TypeScript, Zod v4, Node.js, Codex app-server, Docker Compose, macOS LaunchAgent, SQLite, Cloudflare Tunnel.

---

### Task 1: Merge Current Upstream

**Files:**
- Modify: upstream-overlapping source, tests, package metadata, and docs
- Preserve: `src/web-only-policy.ts`, `src/worktree-rotation.ts`, `deploy/devserver/**`

- [ ] Merge `origin/main` with `--no-commit` and resolve conflicts semantically.
- [ ] Preserve worktree archive migration compatibility by keeping existing migration numbers and adding any required later idempotent migration.
- [ ] Preserve Git lifecycle writes, access summary, `complete_workspace`, and DevServer deployment definitions.
- [ ] Run `npm ci`, `npm run typecheck`, and upstream-focused Subagent tests.
- [ ] Commit the upstream merge before policy-specific work.

### Task 2: Add Strict Provider Configuration

**Files:**
- Modify: `src/local-agent-config.ts`
- Modify: `src/local-agent-config.test.ts`
- Modify: `src/local-agent-manager.ts`
- Modify: `src/local-agent-manager.test.ts`
- Modify: `src/local-agent-catalog.ts`
- Modify: `src/local-agent-catalog.test.ts`

- [ ] Add failing schema tests for `allowOverrides: false` requiring `model` and `effort`.
- [ ] Add failing resolution tests proving omitted values resolve to provider defaults, matching values pass, and mismatches return a non-retryable policy error.
- [ ] Add failing catalog tests proving mismatched profiles are omitted.
- [ ] Implement optional `allowOverrides`, defaulting to `true` for compatibility.
- [ ] Implement one strict selection function used by start, continue, profile resolution, and catalog construction.
- [ ] Run all local-agent config/manager/catalog tests and commit.

### Task 3: Preserve Web-Only Delegation Boundary

**Files:**
- Modify: `src/web-only-policy.ts`
- Modify: `src/web-only-policy.test.ts`
- Modify: `src/server.ts`
- Modify: `src/server-cheap.test.ts`
- Modify: `skills/subagents/SKILL.md`

- [ ] Add failing tests showing direct `codex`, `claude`, OpenCode, Pi, Cursor, Copilot, and OMX commands remain blocked.
- [ ] Add failing tests showing only the exact `devspace agents ls|targets|run|continue|show` commands are allowed.
- [ ] Update policy text to describe policy-enforced Subagents without permitting arbitrary local-agent execution.
- [ ] Remove model/effort override guidance from the model-facing skill.
- [ ] Run policy/server/skill tests and commit.

### Task 4: Add DevServer Codex Bootstrap

**Files:**
- Create: `deploy/devserver/codex-bootstrap.sh`
- Modify: `deploy/devserver/Dockerfile`
- Modify: `deploy/devserver/compose.yaml`
- Modify: `src/devserver-deployment.test.ts`
- Modify: `deploy/devserver/README.md`

- [ ] Add failing static tests requiring a bundled Codex fallback, verified staged updater, persistent active prefix, and `CODEX_COMMAND`.
- [ ] Implement startup bootstrap that installs `@openai/codex@latest` into a temporary prefix, verifies `--version` and `app-server --help`, then atomically activates it.
- [ ] Preserve the previous active prefix and fall back to the image Codex when update fails.
- [ ] Stop stale `devspace-agentd` after a successful activation.
- [ ] Run shellcheck, deployment contract tests, Compose validation, and a remote Docker build.
- [ ] Commit DevServer bootstrap changes.

### Task 5: Configure Mac Strict Policy

**Files:**
- Runtime: `~/.devspace/config.json`
- Runtime: `~/Library/LaunchAgents/com.ciward.devspace.plist`

- [ ] Save timestamped backups of current config and LaunchAgent.
- [ ] Write only the strict Codex provider object while preserving unrelated config fields.
- [ ] Build the linked checkout and restart the LaunchAgent.
- [ ] Verify `devspace doctor` and `devspace agents targets --json` expose only Codex Luna/max.
- [ ] Verify mismatched overrides fail and one bounded real Luna/max call succeeds.

### Task 6: Configure DevServer Codex And TokenLab Key

**Files:**
- Runtime: `/home/ubuntu/.devserver/home/.devspace/config.json`
- Runtime: `/home/ubuntu/.devserver/home/.codex/config.toml`
- Runtime: `/home/ubuntu/.devserver/home/.npm-global/`

- [ ] Record TokenLab production image and health before mutation.
- [ ] Resolve exactly one active API key named `devserver` inside TokenLabOVH without returning its value.
- [ ] Back up existing DevServer config files with mode `0600`.
- [ ] Write strict Subagents configuration and minimal Codex TokenLab provider configuration server-side.
- [ ] Recreate only `devserver` and confirm the persistent Codex update path succeeds.
- [ ] Verify `doctor`, target catalog, mismatched override rejection, and one bounded real Luna/max call.
- [ ] Verify usage attribution belongs to the exact `devserver` key without exposing the key.

### Task 7: Full Verification And Release

**Files:**
- Modify as required by test failures only within this feature's scope

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Scan tracked diffs, Docker inspect output, logs, and process arguments for the TokenLab key.
- [ ] Verify Mac local/public health, OAuth discovery, and MCP unauthorized semantics.
- [ ] Verify DevServer public health, Cloudflare Tunnel, OAuth discovery, SSH access, resource limits, and worktree configuration.
- [ ] Re-prove TokenLab production image, health, and monitor state are unchanged.
- [ ] Commit final fixes, push `devspace-cheap`, and verify remote SHA equals local HEAD.
