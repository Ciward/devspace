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
- Local coding agents and subagents remain disabled by `devspace-cheap`.
- The container is limited to 4 CPUs, 8 GiB memory, 12 GiB memory plus swap, and
  4096 PIDs. Its root filesystem is read-only and all Linux capabilities are
  dropped.

## Server layout

```text
/home/ubuntu/work/                  host and container workspace root
/home/ubuntu/.devserver/home/       persistent container home and DevSpace state
/home/ubuntu/.devserver/cloudflared tunnel config and credentials
```

The public connector URL is `https://devserver.ciward.dpdns.org/mcp`. A dedicated
Cloudflare Tunnel connects directly to the `devserver` container on the private
Compose network. Port `17676` is published only on server loopback for health and
diagnostic probes.

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

## SSH access

Generate a dedicated Ed25519 key inside
`/home/ubuntu/.devserver/home/.ssh`. Keep the private key only there. Install
only its public key in each approved remote account's `authorized_keys`, then
write a minimal SSH config containing the approved host aliases and any required
`ProxyJump` relationships. Do not copy an operator workstation's private keys
into DevServer.
