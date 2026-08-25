# Strict Codex Subagents Design

Date: 2026-08-25
Status: Approved

## Objective

Update `devspace-cheap` to the current upstream DevSpace implementation and
re-enable subagents under one strict policy:

- provider: `codex`
- model: `gpt-5.6-luna`
- effort: `max`
- runtime overrides: forbidden

Apply the same policy to the Mac DevSpace service and the OVH DevServer
deployment. Preserve the existing web-model workflow, Git lifecycle access,
managed-worktree rotation and archive behavior, Cloudflare endpoints, and
DevServer development environment.

## Upstream Baseline

The current upstream `origin/main` already provides the required foundations:

- structured Subagents configuration by provider;
- provider defaults for `model` and `effort`;
- a daemon-owned local-agent runtime;
- host-installed Codex `app-server` integration;
- profile discovery and model-facing Subagent guidance.

The upstream precedence order is invocation override, profile value, then
provider default. That behavior is not strict enough for this deployment and
will be extended without changing its default compatibility behavior.

## Configuration Contract

Both deployments use:

```json
{
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.6-luna",
        "effort": "max",
        "allowOverrides": false
      }
    ]
  }
}
```

`allowOverrides` is optional for upstream compatibility. Missing or `true`
preserves upstream precedence. When it is `false`:

- `model` and `effort` are required;
- the provider configuration is authoritative;
- an invocation supplying a different model or effort is rejected;
- a profile supplying a different model or effort is rejected;
- omitted invocation/profile values resolve to the fixed provider values;
- only configured and available providers and matching profiles are exposed.

Providers omitted from the configuration remain disabled. This deployment
configures only Codex.

## Web-Only Policy

The web-hosted ChatGPT or Claude model remains the orchestrator. Direct local
agent execution remains blocked, including direct `codex`, `claude`,
`opencode`, Pi, Cursor, Copilot, and OMX orchestration commands.

The sole delegated execution path is DevSpace's policy-enforced command surface:

```text
devspace agents ls
devspace agents targets
devspace agents run
devspace agents continue
devspace agents show
```

The model-facing Subagent skill does not advertise model or effort overrides.
Human CLI overrides remain syntactically accepted for upstream compatibility,
but strict policy rejects values that differ from the configured selection.

## Mac Deployment

The Mac service uses the existing host-installed Codex CLI and Codex
authentication/configuration. Current local evidence confirms:

- Codex CLI supports `app-server`;
- the model catalog contains `gpt-5.6-luna`;
- `gpt-5.6-luna` supports `max` effort.

The Mac `~/.devspace/config.json` receives the strict Subagents configuration.
The global npm-linked DevSpace checkout is rebuilt and its LaunchAgent is
restarted. Existing Codex provider credentials are not copied or rewritten.

## DevServer Deployment

Codex runs directly in the existing `devserver` container. No additional agent
sidecar is introduced.

The image includes a known-good Codex CLI fallback. The persistent container
home keeps the active Codex installation under:

```text
/home/ubuntu/.npm-global
```

At container startup, a bootstrap command checks and installs
`@openai/codex@latest`. The update contract is:

- update through a staged temporary prefix;
- verify `codex --version` and `codex app-server --help` before activation;
- atomically switch the active persistent installation;
- retain the previous working installation until the new one is verified;
- continue startup with the previous or image fallback version if the network,
  npm registry, install, or validation fails;
- after activation, stop an existing DevSpace agent daemon so the next call
  starts against the new Codex binary.

The updater changes only the Codex CLI. It never changes the fixed DevSpace
model or effort policy.

## TokenLab Key

Use the active TokenLab API key named `devserver`, matching the user-provided
masked key identity. The full key is obtained only inside TokenLabOVH from the
protected production runtime/data source. It must not cross SSH output, appear
in chat, enter Git, or enter image layers.

Write the minimal DevServer Codex configuration to:

```text
/home/ubuntu/.codex/config.toml
```

with mode `0600`. It configures:

- provider endpoint: `https://api.tokenlab.cc.cd`;
- Responses wire protocol;
- TokenLab bearer credential;
- default model `gpt-5.6-luna`;
- default reasoning effort `max`.

The user explicitly accepts that ordinary DevServer shell access can read this
local configuration. The credential is still excluded from logs, source,
Compose configuration, Docker image metadata, and command-line arguments.

Before installation, verify exactly one active key matches the name and masked
identity. Fail closed on zero or multiple matches.

## Data Flow

1. The web model opens a workspace and receives the enabled Codex target.
2. The web model invokes `devspace agents run` without model/effort flags.
3. DevSpace resolves the configured Codex provider.
4. Strict policy fixes the selection to Luna/max and rejects mismatches.
5. `devspace-agentd` starts or reuses host-installed Codex `app-server`.
6. Codex uses the deployment's existing Mac credential or the DevServer
   TokenLab `devserver` credential.
7. DevSpace returns a durable agent id and inspectable result to the web model.

## Failure Behavior

- Disabled provider: omit from catalog and reject direct targeting.
- Unavailable Codex executable/app-server: report provider unavailable without
  enabling another provider.
- Model or effort override mismatch: return a non-retryable policy error naming
  the fixed selection without exposing credentials.
- Invalid profile selection: omit or reject the profile; never silently switch
  models.
- Codex auto-update failure: retain the previous verified installation and keep
  DevSpace available.
- TokenLab key lookup ambiguity: do not write or replace Codex configuration.
- TokenLab authentication failure: report the provider error; do not fall back
  to another key or provider.

## Migration And Compatibility

Merge current upstream `origin/main` into `devspace-cheap` first. Preserve the
branch's custom behavior while adopting the upstream Subagent daemon/runtime
architecture.

Legacy boolean Subagents configuration remains readable. Existing upstream
configurations without `allowOverrides` preserve their current override
behavior. Only explicit `allowOverrides: false` enables strict selection.

## Verification

Repository verification:

- strict config schema and legacy compatibility tests;
- resolution tests for omitted, matching, and mismatched overrides;
- profile mismatch and catalog filtering tests;
- Web-only command-policy tests;
- full test suite, typecheck, and production build;
- Docker Compose schema and image build checks.

Mac runtime verification:

- `devspace doctor` reports only Codex enabled and available;
- `devspace agents targets --json` reports Luna/max;
- one bounded real Subagent call records `gpt-5.6-luna` and `max`;
- local and public health/OAuth/MCP probes remain correct.

DevServer runtime verification:

- Codex update/fallback bootstrap succeeds and reports a valid app-server;
- Codex config and TokenLab key file permissions are `0600`;
- the key never appears in Docker inspect, logs, Git diff, or process arguments;
- one bounded real Subagent call records Luna/max and creates TokenLab usage on
  the exact `devserver` key;
- DevServer health, Cloudflare Tunnel, SSH access, worktree policy, and MCP OAuth
  remain healthy;
- TokenLab production image, health endpoint, and monitor remain unchanged.

## Rollback

- Git rollback: redeploy the previous `devspace-cheap` commit.
- Mac runtime rollback: restore the previous config backup and restart the
  LaunchAgent.
- DevServer runtime rollback: restore the previous Compose/source revision and
  persistent Codex config backup, then recreate only DevServer-owned containers.
- Credential rollback: remove the DevServer Codex config or restore its previous
  file; never rotate or delete the TokenLab API key as part of application
  rollback.
