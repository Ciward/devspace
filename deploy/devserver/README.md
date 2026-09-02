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
  `/home/ubuntu/.devserver/home` on the server.
- Cloudflare Tunnel credentials persist separately in
  `/home/ubuntu/.devserver/cloudflared`.
- Only `/home/ubuntu/work` is exposed as an allowed workspace root.
- Subagent delegation is available only through DevSpace's configured Codex
  provider. The deployed config locks Codex to `gpt-5.6-luna` with `max`
  reasoning and rejects model or effort overrides. Codex uses a setuid system
  `bubblewrap` binary for its nested Linux sandbox. Following OpenAI's container
  guidance, the DevServer service disables Docker's outer seccomp/AppArmor
  profiles and grants only the capabilities needed for nested sandbox setup.
- The container is limited to 4 CPUs, 12 GiB memory, 16 GiB memory plus swap, and
  4096 PIDs. Its root filesystem is read-only. All Linux capabilities are
  dropped except `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`, `SYS_PTRACE`,
  and `NET_ADMIN`, which are granted to let the nested Codex/bubblewrap sandbox
  initialize and configure its isolated loopback interface. The
  Docker socket is still not mounted.
- The image includes Node 26.3.0/npm 11.16.0, Go 1.26.6, Rust/Cargo 1.94.1,
  GitHub CLI 2.86.0, pnpm 10.23.0, yarn 1.22.22, Chromium with Noto CJK
  fonts, zsh, tmux, shellcheck, GnuPG, PostgreSQL client headers, and Python
  build headers.
- A persistent Python 3.12.11 environment is available at
  `/home/ubuntu/.venvs/local-python`; it contains the non-secret user packages
  from the Mac's user Python environment. `uv` 0.8.17 manages it.
- Git global identity, HTTP/1.1, large push buffer, Git LFS, GitHub CLI aliases,
  and GitHub HTTPS credential integration match the Mac's safe settings.

## Server layout

```text
/home/ubuntu/work/                  host and container workspace root
/home/ubuntu/.devserver/home/       persistent container home and DevSpace state
/home/ubuntu/.devserver/cloudflared tunnel config and credentials
/home/ubuntu/.devserver/home/.config/gh/ GitHub CLI state
/home/ubuntu/.devserver/home/.venvs/  persistent Python environments
/home/ubuntu/.devserver/tmp80/      dedicated 80 GiB filesystem mounted at /tmp
```

The public connector URL is `https://devserver.ciward.dpdns.org/mcp`. A dedicated
Cloudflare Tunnel connects directly to the `devserver` container on the private
Compose network. Port `17676` is published only on server loopback for health and
diagnostic probes.

DevServer exposes the full DevSpace tool surface, including the legacy
`write`/`edit`/`grep`/`glob`/`ls`/`bash` names expected by existing ChatGPT
conversations. `bash` is resumable: it returns a process session after a
five-second yield instead of holding one MCP request open for multi-minute tests
or builds, and the host continues it through `write_stdin`. The
`exec_command`/`write_stdin` pair is also available for hosts that already know
the Codex-compatible process lifecycle.
`/tmp` is a dedicated, disk-backed 80 GiB ext4 filesystem with normal sticky
directory permissions and executable build output. It is separate from the
container root filesystem and supports Go linking, Node builds, and Chromium.

## Operations

From the repository root on the server:

```bash
docker compose -f deploy/devserver/compose.yaml build --pull
docker compose -f deploy/devserver/compose.yaml up -d
docker compose -f deploy/devserver/compose.yaml ps
curl -fsS http://127.0.0.1:17676/healthz
```

Before the first start, create both
`/home/ubuntu/.devserver/home/.devspace/config.json` and
`/home/ubuntu/.devserver/home/.devspace/auth.json` with mode `0600`. The config
file may contain an empty JSON object because Compose supplies the runtime
settings. The auth file must contain a freshly generated `ownerToken` and must
never be committed, printed in logs, or copied into the Compose environment.

Prepare the dedicated `/tmp` filesystem once on the server before starting or
upgrading DevServer:

```bash
sudo deploy/devserver/prepare-tmp-storage.sh
```

The script creates a sparse 80 GiB ext4 image under
`/home/ubuntu/.devserver/storage`, adds an idempotent loop mount to `/etc/fstab`,
mounts it at `/home/ubuntu/.devserver/tmp80`, and enforces mode `1777`.

Configure Codex with an existing active TokenLab API key by name, entirely on
the OVH server:

```bash
deploy/devserver/configure-tokenlab-codex.sh devserver
```

The script requires exactly one matching active, unexpired key, writes only to
the persistent DevServer home with mode `0600`, and never prints the key. Its
portable Codex defaults mirror the Mac: `gpt-5.6-sol` with `xhigh` reasoning,
a 1,000,000-token declared context window, a 900,000-token auto-compact limit,
the same non-interactive execution policy, six concurrent agent threads, and a
trusted workspace parent. Mac-only notification commands, plugin cache paths,
and macOS project paths are intentionally omitted. DevSpace still passes its
strict `gpt-5.6-luna` / `max` selection explicitly for every bounded subagent
thread and turn.

The current GitHub CLI login is persisted in
`/home/ubuntu/.devserver/home/.config/gh/hosts.yml` with mode `0600`. GitHub
operations use HTTPS through `gh auth git-credential`. Revoke it with
`gh auth logout --hostname github.com` inside the container when needed.

## SSH access

Generate a dedicated Ed25519 key inside
`/home/ubuntu/.devserver/home/.ssh`. Keep the private key only there. Install
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
