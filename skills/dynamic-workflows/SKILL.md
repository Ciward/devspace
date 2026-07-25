---
name: dynamic-workflows
description: Orchestrate multi-agent coding workflows via DevSpace Dynamic Workflows (CLI or MCP).
---

# Dynamic Workflows

Use this skill when the user wants multi-step, multi-agent orchestration — fan-out
review, migrate-and-verify, research panels — **not** a single subagent turn.

## Entry points

| Host | Surface |
|---|---|
| Coding agent (Claude Code, Codex, pi, …) | CLI + this skill |
| ChatGPT / MCP client | MCP tools `run_workflow` / `workflow_status` / `workflow_cancel` |

```bash
devspace workflow run --file path/to/script.js [--arg k=v]... [--follow]
devspace workflow run --script-path path/to/script.js [--resume <runId>] [--follow]
devspace workflow run --name review-auth [--follow]
devspace workflow run --resume <runId>
devspace workflow status <runId> [--follow]
devspace workflow cancel <runId>
devspace workflow ls
devspace workflow calls <runId>
devspace workflow call <runId> <callIndex>
```

Named scripts: `.devspace/workflows/<name>.js` or `workflows/<name>.js`.

## Script shape

```js
export const meta = {
  name: 'review-auth',
  description: 'Fan-out review of auth changes',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
  // optional DevSpace:
  // defaultProvider: 'codex',
  // concurrency: 4,
}

phase('Review')
const findings = await parallel([
  () => agent('Review for correctness…', { label: 'correctness' }),
  () => agent('Review for security…', { label: 'security' }),
])
phase('Synthesize')
const summary = await agent(`Synthesize: ${JSON.stringify(findings)}`)
return { summary, findings }
```

### Primitives

| API | Notes |
|---|---|
| `agent(prompt, opts?)` | Throws on failure. `opts`: `label`, `phase`, `schema`, `model`, `effort`, `provider`, `isolation: 'worktree'` |
| `parallel(thunks)` | Barrier; throw → `null` slot |
| `pipeline(items, ...stages)` | Per-item chains; no cross-item barrier |
| `settle(() => operation)` | DevSpace extension: convert a thrown operation into `{ ok, value }` or `{ ok, error: { kind, message, retryable } }` |
| `phase(title)` / `log(msg)` | Progress; journaled |
| `args` | Run input (object preferred) |
| `workflow(name\|{scriptPath}, args?)` | Nested, depth 1, shared call index |

**No `writeMode`.** Teach read-only vs write in the prompt. Use `isolation: 'worktree'` when parallel mutators would conflict (git required).

### Failure-aware orchestration

Default behavior stays Claude-compatible: direct `agent()` failures throw, while
`parallel()` and `pipeline()` map a failed branch/item to `null`. Use `settle()`
only when the script must distinguish failure kinds or implement fallback:

```js
const primary = await settle(() =>
  agent('Read-only security review', { provider: 'claude' }),
)

const review = primary.ok
  ? primary
  : primary.error.kind === 'provider_unavailable'
    ? await settle(() =>
        agent('Read-only security review', { provider: 'codex' }),
      )
    : primary

return review
```

Inside `parallel()`, wrap each branch with `settle()` to preserve failures as
data instead of `null`. Failed settled outcomes are journaled failures and are
not replayed as successful cached agent results.

### Determinism bans

`Date.now()`, `Math.random()`, and `new Date()` without args throw. Pass timestamps via `args` if needed.

### Schema

```js
const out = await agent('Return JSON findings', {
  schema: {
    type: 'object',
    properties: { bugs: { type: 'array', items: { type: 'string' } } },
    required: ['bugs'],
  },
})
// out is validated object; engine retries ≤2 on invalid JSON
// codex/claude: native structured output first, then prompt repair; others: prompt+Ajv
```

### Providers

Default: first **enabled ∩ available** provider (`agentProviders.enabled` in config, else all live providers in product order). Override with `opts.provider` or `meta.defaultProvider`.

### Resume

Failed and cancelled runs are terminal. Recovery creates a **new** run:

1. Inspect the prior run with `workflow status`, `workflow calls`, and
   `workflow call`.
2. Edit the persisted `scriptPath` reported by the run, or pass a different
   `--script-path`.
3. Keep prompts and agent options stable for completed calls whose return values
   should be reused.
4. Run `devspace workflow run --resume <runId>` (optionally with
   `--script-path <path>`).

Replay first matches the same call index and cache key, then consumes one
compatible prior cache key after reordering. The new run records whether each
call was reused by same-index or compatible-key matching, and where it came
from. Failed, interrupted, changed, or unmatched calls execute live.

Replay restores an agent's **return value**. It does not recreate shared-checkout
edits or reapply a prior worktree diff. Verify required filesystem state before
depending on a replayed mutating call.

### Cancel

`workflow cancel` sets a cooperative flag; worker aborts then hard-kills if needed.

## When to use CLI vs MCP

- **CLI**: host agent can shell; prefer for long runs + `--follow`.
- **MCP**: ChatGPT plans; call `run_workflow`, then `workflow_status` until terminal. Disconnecting MCP does **not** kill the worker.

## Worked mini-examples

**1. Parallel review**

```js
export const meta = { name: 'p-review', description: 'Two reviewers' }
const [a, b] = await parallel([
  () => agent('Correctness review of the diff', { label: 'corr' }),
  () => agent('Security review of the diff', { label: 'sec' }),
])
return { a, b }
```

**2. Pipeline with schema**

```js
export const meta = { name: 'pipe', description: 'Find then fix plan' }
return await pipeline(
  args.files,
  (file) => agent(`List bugs in ${file}`, { schema: { type: 'object', properties: { bugs: { type: 'array', items: { type: 'string' } } }, required: ['bugs'] } }),
  (findings, file) => agent(`Plan fixes for ${file}: ${JSON.stringify(findings)}`),
)
```

**3. Isolation for parallel writers**

```js
export const meta = { name: 'iso', description: 'Parallel mutators' }
await parallel([
  () => agent('Implement feature A in isolation', { isolation: 'worktree', label: 'a' }),
  () => agent('Implement feature B in isolation', { isolation: 'worktree', label: 'b' }),
])
// dirty worktrees preserved; compose via return text / shared follow-up
```
