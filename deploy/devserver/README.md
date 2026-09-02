# DevServer Docker deployment

This deployment runs the `devspace-cheap` branch as an isolated Docker development
environment. The MCP host works inside `/home/ubuntu/work`, which is bind-mounted
to the server's `/home/ubuntu/work` directory at the same absolute path.

## Boundaries

- The host Docker socket is not mounted, so container processes have no direct
  Docker API path. This does not reduce privileges obtained through SSH: if the
  dedicated key is authorized for an account that can operate Docker, DevServer
  can exercise that authority through an SSH command. In particular, access to
  the TokenLabOVH `ubuntu` account must be treated as production-admin access.
- DevSpace state, OAuth credentials, SSH credentials, and tool caches persist in
  `/srv/devserver/runtime/home` on the dedicated disk.
- Cloudflare Tunnel credentials persist separately in
  `/srv/devserver/runtime/cloudflared`.
- Only `/home/ubuntu/work` is exposed as an allowed workspace root.
- Subagent delegation is available only through DevSpace's configured Codex
  provider. The deployed config locks Codex to `gpt-5.6-luna` with `max`
  reasoning, rejects model or effort overrides, and admits at most two
  concurrent turns in FIFO order. Codex's own thread scheduler is also capped
  at two threads per session. DevSpace automatically approves all Codex
  app-server command, file-change, and additional-permission requests, including
  SSH and production deployment operations. Every configured Codex turn uses
  `danger-full-access` regardless of its write-mode hint. Codex uses a setuid system
  `bubblewrap` binary for its nested Linux sandbox. Following OpenAI's container
  guidance, the DevServer service disables Docker's outer seccomp/AppArmor
  profiles and grants only the capabilities needed for nested sandbox setup.
- The container is limited to 4 CPUs, 12 GiB memory, 16 GiB memory plus swap, and
  4096 PIDs. Its OOM score is raised so a host-wide emergency prefers DevServer
  over TokenLab production processes. Its root filesystem is read-only. All Linux capabilities are
  dropped except `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`, `SYS_PTRACE`,
  and `NET_ADMIN`, which are granted to let the nested Codex/bubblewrap sandbox
  initialize and configure its isolated loopback interface. The
  Docker socket is still not mounted.
- The image includes Node 26.3.0/npm 11.16.0, Go 1.26.6, Rust/Cargo 1.94.1,
  GitHub CLI 2.86.0, pnpm 11.25.0, yarn 1.22.22, Chromium with Noto CJK
  fonts, zsh, tmux, shellcheck, GnuPG, PostgreSQL client headers, and Python
  build headers.
- A persistent Python 3.12.11 environment is available at
  `/home/ubuntu/.venvs/local-python`; it contains the non-secret user packages
  from the Mac's user Python environment. `uv` 0.8.17 manages it.
- Git global identity, HTTP/1.1, large push buffer, Git LFS, GitHub CLI aliases,
  and GitHub HTTPS credential integration match the Mac's safe settings.

## Server layout

```text
/srv/devserver/containerd/          dedicated containerd content and snapshots
/srv/devserver/docker/              dedicated Docker metadata and logs
/srv/devserver/runtime/home/        persistent container home and DevSpace state
/srv/devserver/runtime/work/        host and container workspace root
/srv/devserver/runtime/tmp/         container /tmp
/srv/devserver/runtime/cloudflared/ tunnel config and credentials
/home/ubuntu/work/                  compatibility symlink to runtime/work
/run/docker-devserver.sock          dedicated Docker control socket
```

The public connector URL is `https://devserver.ciward.dpdns.org/mcp`. A dedicated
Cloudflare Tunnel connects directly to the `devserver` container on the private
Compose network. Docker does not publish an application port; a systemd socket
proxy listens on `127.0.0.1:17676` and forwards health and diagnostic probes to
the container's fixed private address.

The two Docker daemons also use different default bridges. System Docker keeps
`docker0`, while the dedicated daemon owns `br-ds-default` on
`172.30.251.0/24`. DevServer traffic uses a separate `br-devserver` bridge on
`172.30.250.0/24`. Do not change the dedicated daemon back to `bridge=none`:
Docker Engine 29 was observed deleting the live system `docker0` during startup,
which disconnected the existing Reality, Hysteria2, and subscription containers.
The systemd unit and verification scripts now fail closed unless the system
bridge, dedicated default bridge, and DevServer workload bridge are all intact.

Abandoned MCP transports are retained for at most five minutes, checked every
30 seconds, and capped at 128 sessions. This matches ChatGPT's short-lived MCP
connection pattern and prevents transport state from accumulating for a full
day.

DevServer exposes the full DevSpace tool surface, including the legacy
`write`/`edit`/`grep`/`glob`/`ls`/`bash` names expected by existing ChatGPT
conversations. `bash` is resumable: it returns a process session after a
five-second yield instead of holding one MCP request open for multi-minute tests
or builds, and the host continues it through `write_stdin`. The
`exec_command`/`write_stdin` pair is also available for hosts that already know
the Codex-compatible process lifecycle.
The 100 GiB ext4 filesystem mounted at `/srv/devserver` is the hard capacity
boundary for the complete DevServer runtime, including images, logs, home,
workspaces, caches, and `/tmp`. The container root filesystem stays read-only,
while `/tmp` retains normal sticky permissions and executable build output.

## Operations

Install or refresh the isolated runtime and its systemd units from the repository
root on the server:

```bash
sudo deploy/devserver/install-isolated-runtime.sh
deploy/devserver/devserver-compose.sh build --pull
deploy/devserver/devserver-compose.sh up -d
deploy/devserver/devserver-compose.sh ps
sudo deploy/devserver/devserver-storage-verify.sh
curl -fsS http://127.0.0.1:17676/healthz
```

Do not run this deployment through the default Docker socket. The wrapper fails
closed unless `/srv/devserver` is the expected dedicated device and Docker reports
`/srv/devserver/docker` as its root.

Before the first start, create both
`/srv/devserver/runtime/home/.devspace/config.json` and
`/srv/devserver/runtime/home/.devspace/auth.json` with mode `0600`. The config
file may contain an empty JSON object because Compose supplies the runtime
settings. The auth file must contain a freshly generated `ownerToken` and must
never be committed, printed in logs, or copied into the Compose environment.

`prepare-tmp-storage.sh` remains only as a compatibility alias for
`install-isolated-runtime.sh`; it no longer creates a loop image.

## Automatic stability maintenance

`devserver-maintenance.timer` runs five minutes after boot and every five minutes
thereafter, with a 30-second randomized delay and persistent catch-up after
downtime. Every run first verifies `/dev/sdb1`, `/srv/devserver`, the dedicated
Docker socket and Docker root. It will not fall back to the system disk or the
TokenLab Docker daemon.

The maintenance job performs these bounded actions:

- Starts either dedicated container if it is stopped and restarts DevServer only
  after Docker's healthcheck has declared it `unhealthy`.
- Restarts Cloudflared after three consecutive public `/healthz` failures; one
  transient network failure does not cause churn.
- Removes only old Go build directories, `/tmp` entries, incomplete backup parts,
  exited dedicated-runtime containers, dangling images, and old BuildKit cache.
- At 70% disk use, prunes older unused images and retains 4 GiB of build cache. At
  85%, it removes all unused images, retains 1 GiB of build cache, and prunes
  regenerable package caches when no build process is active. At 92%, it emits a
  critical journal event for external alerting.
- Records cgroup memory current/peak/max, swap use, PID count, and OOM events. It
  does not call `drop_caches`; Linux reclaims page cache itself, while Docker
  enforces the existing 12 GiB memory plus 4 GiB swap boundary.

Repositories, worktrees, DevSpace/Codex sessions, SSH/GitHub credentials,
Cloudflare credentials, and Docker volumes are excluded from automatic cleanup.
Override watermarks or the public-failure count in
`/etc/default/devserver-maintenance`, for example:

```bash
DEVSERVER_DISK_SOFT_PERCENT=70
DEVSERVER_DISK_HARD_PERCENT=85
DEVSERVER_DISK_CRITICAL_PERCENT=92
DEVSERVER_PUBLIC_FAILURE_LIMIT=3
```

Inspect the current and previous maintenance result with:

```bash
systemctl status devserver-maintenance.timer devserver-maintenance.service
journalctl -u devserver-maintenance.service --since today
```

Configure Codex with an existing active TokenLab API key by name, entirely on
the OVH server:

```bash
deploy/devserver/configure-tokenlab-codex.sh devserver
```

The script requires exactly one matching active, unexpired key, writes only to
the persistent DevServer home with mode `0600`, and never prints the key. Its
portable Codex defaults mirror the Mac: `gpt-5.6-sol` with `xhigh` reasoning,
a 1,000,000-token declared context window, a 900,000-token auto-compact limit,
the same non-interactive execution policy, two concurrent agent threads by
default, and a
trusted workspace parent. Mac-only notification commands, plugin cache paths,
and macOS project paths are intentionally omitted. DevSpace still passes its
strict `gpt-5.6-luna` / `max` selection explicitly for every bounded subagent
thread and turn.

Set `DEVSERVER_CODEX_MAX_CONCURRENT_THREADS` when running the configuration
script to choose a value from 1 to 32. DevSpace independently limits active
subagent turns through `DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS`; DevServer uses
2 so excess turns wait without starting another runtime or compiler workload.

The current GitHub CLI login is persisted in
`/srv/devserver/runtime/home/.config/gh/hosts.yml` with mode `0600`. GitHub
operations use HTTPS through `gh auth git-credential`. Revoke it with
`gh auth logout --hostname github.com` inside the container when needed.

## SSH access

Generate a dedicated Ed25519 key inside
`/srv/devserver/runtime/home/.ssh`. Keep the private key only there. Install
only its public key in each approved remote account's `authorized_keys`, then
write a minimal SSH config containing the approved host aliases and any required
`ProxyJump` relationships. Do not copy an operator workstation's private keys
into DevServer.

Local model-agent CLIs such as Codex, Claude Code, OpenCode, and OpenClaw
remain blocked as direct shell commands. Codex is installed in the image as a
known-good fallback, checked for updates when the container starts, and exposed
only through DevSpace's policy-enforced `devspace agents` commands. The web
model remains the orchestrator and `DEVSPACE_SUBAGENTS=1` enables that bounded
delegation path.
