import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dockerfile = await readFile(
  new URL("../deploy/devserver/Dockerfile", import.meta.url),
  "utf8",
);
const compose = await readFile(
  new URL("../deploy/devserver/compose.yaml", import.meta.url),
  "utf8",
);
const codexBootstrap = await readFile(
  new URL("../deploy/devserver/codex-bootstrap.sh", import.meta.url),
  "utf8",
);
const codexConfig = await readFile(
  new URL("../deploy/devserver/configure-tokenlab-codex.sh", import.meta.url),
  "utf8",
);
const tmpStorage = await readFile(
  new URL("../deploy/devserver/prepare-tmp-storage.sh", import.meta.url),
  "utf8",
);
const isolatedRuntimeInstaller = await readFile(
  new URL("../deploy/devserver/install-isolated-runtime.sh", import.meta.url),
  "utf8",
);
const composeWrapper = await readFile(
  new URL("../deploy/devserver/devserver-compose.sh", import.meta.url),
  "utf8",
);
const storageVerifier = await readFile(
  new URL("../deploy/devserver/devserver-storage-verify.sh", import.meta.url),
  "utf8",
);
const containerdConfig = await readFile(
  new URL("../deploy/devserver/runtime/containerd.toml", import.meta.url),
  "utf8",
);
const dockerConfig = await readFile(
  new URL("../deploy/devserver/runtime/daemon.json", import.meta.url),
  "utf8",
);
const containerdService = await readFile(
  new URL("../deploy/devserver/systemd/containerd-devserver.service", import.meta.url),
  "utf8",
);
const dockerService = await readFile(
  new URL("../deploy/devserver/systemd/docker-devserver.service", import.meta.url),
  "utf8",
);
const networkScript = await readFile(
  new URL("../deploy/devserver/devserver-network.sh", import.meta.url),
  "utf8",
);
const networkService = await readFile(
  new URL("../deploy/devserver/systemd/devserver-network.service", import.meta.url),
  "utf8",
);
const proxySocket = await readFile(
  new URL("../deploy/devserver/systemd/devserver-health-proxy.socket", import.meta.url),
  "utf8",
);
const proxyService = await readFile(
  new URL("../deploy/devserver/systemd/devserver-health-proxy.service", import.meta.url),
  "utf8",
);
const maintenanceScript = await readFile(
  new URL("../deploy/devserver/devserver-maintenance.sh", import.meta.url),
  "utf8",
);
const maintenanceService = await readFile(
  new URL("../deploy/devserver/systemd/devserver-maintenance.service", import.meta.url),
  "utf8",
);
const maintenanceTimer = await readFile(
  new URL("../deploy/devserver/systemd/devserver-maintenance.timer", import.meta.url),
  "utf8",
);

const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
const pnpmInstall = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
const vcsArgument = dockerfile.indexOf("ARG DEVSERVER_VCS_REF");
const runtimeToolchain = dockerfile.indexOf("RUN apt-get update");
assert.notEqual(scriptsCopy, -1, "Docker build must copy postinstall scripts before pnpm install");
assert.ok(scriptsCopy < pnpmInstall, "Docker build must copy postinstall scripts before pnpm install");
assert.match(dockerfile, /COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml/);
assert.match(dockerfile, /pnpm@11\.25\.0/);
assert.doesNotMatch(dockerfile, /package-lock\.json|npm ci/);
assert.ok(
  vcsArgument > runtimeToolchain,
  "Changing only the deployed revision must not invalidate the runtime toolchain layer",
);

assert.match(compose, /pids_limit:\s*4096/);
assert.match(compose, /cloudflare\/cloudflared:2026\.8\.2@sha256:/);
assert.ok(
  compose.includes("/srv/devserver/runtime/work:/home/ubuntu/work"),
  "Compose must preserve the server and container workspace path",
);
assert.match(compose, /DEVSPACE_SUBAGENTS:\s*"1"/);
assert.match(compose, /DEVSPACE_TOOL_MODE:\s*full/);
assert.match(compose, /DEVSPACE_WIDGETS:\s*full/);
assert.match(compose, /DEVSPACE_RESUMABLE_BASH:\s*"1"/);
assert.match(compose, /DEVSPACE_RESUMABLE_BASH_YIELD_MS:\s*"5000"/);
assert.match(compose, /DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS:\s*"300000"/);
assert.match(compose, /DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS:\s*"30000"/);
assert.match(compose, /DEVSPACE_MCP_SESSION_MAX_COUNT:\s*"128"/);
assert.match(compose, /DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS:\s*"2"/);
assert.match(compose, /mem_limit:\s*12g/);
assert.match(compose, /memswap_limit:\s*16g/);
assert.match(compose, /TMPDIR:\s*\/tmp/);
assert.match(compose, /GOTMPDIR:\s*\/tmp/);
assert.doesNotMatch(compose, /DEVSERVER_HOME|DEVSERVER_WORK_ROOT|DEVSERVER_TMP_ROOT/);
assert.ok(compose.includes("/srv/devserver/runtime/home:/home/ubuntu"));
assert.ok(compose.includes("/srv/devserver/runtime/work:/home/ubuntu/work"));
assert.ok(compose.includes("/srv/devserver/runtime/tmp:/tmp"));
assert.ok(compose.includes("/srv/devserver/runtime/cloudflared:/etc/cloudflared:ro"));
assert.match(compose, /external:\s*true/);
assert.match(compose, /ipv4_address:\s*172\.30\.250\.10/);
assert.match(compose, /ipv4_address:\s*172\.30\.250\.11/);
assert.doesNotMatch(compose, /ports:/);
assert.match(compose, /max-size:\s*"64m"/);
assert.match(compose, /max-file:\s*"2"/);
assert.doesNotMatch(compose, /\/tmp:rw,noexec,nosuid,size=2g/);
assert.match(compose, /CHROME_PATH:\s*\/usr\/bin\/chromium/);
assert.match(compose, /TZ:\s*Asia\/Shanghai/);
assert.match(compose, /seccomp=unconfined/);
assert.match(compose, /apparmor=unconfined/);
for (const capability of ["SYS_ADMIN", "SYS_CHROOT", "SETUID", "SETGID", "SYS_PTRACE", "NET_ADMIN"]) {
  assert.match(compose, new RegExp(capability), `DevServer should grant ${capability} for nested bubblewrap`);
}
assert.doesNotMatch(compose, /docker\.sock/);

assert.match(dockerfile, /@openai\/codex@0\.149\.1/);
assert.match(dockerfile, /bubblewrap/);
assert.match(dockerfile, /chromium/);
assert.match(dockerfile, /fonts-noto-cjk/);
assert.match(dockerfile, /chmod u\+s \/usr\/bin\/bwrap/);
assert.match(dockerfile, /COPY --chmod=0755 deploy\/devserver\/codex-bootstrap\.sh/);
assert.match(dockerfile, /COPY --from=build --chown=ubuntu:ubuntu \/opt\/devspace\/bin \/opt\/devspace\/bin/);
assert.match(dockerfile, /ln -s \/opt\/devspace\/bin\/devspace\.js \/usr\/local\/bin\/devspace/);
assert.doesNotMatch(dockerfile, /ln -s \/opt\/devspace\/dist\/cli\.js/);
assert.match(dockerfile, /codex-bootstrap\.sh/);
assert.match(codexBootstrap, /npm view @openai\/codex version/);
assert.match(codexBootstrap, /app-server --help/);
assert.match(codexBootstrap, /CODEX_COMMAND/);
assert.match(codexBootstrap, /agentd\.lock/);
assert.match(codexBootstrap, /agentd\.pid/);
assert.match(codexBootstrap, /agentd\.sock/);
assert.match(codexBootstrap, /chmod 01777/);
assert.match(codexBootstrap, /\.profile/);
assert.match(codexBootstrap, /\.bash_profile/);
assert.match(codexBootstrap, /\.zprofile/);
assert.match(codexBootstrap, /\/usr\/local\/go\/bin/);
assert.match(codexBootstrap, /\/usr\/local\/cargo\/bin/);
assert.doesNotMatch(tmpStorage, /truncate|mkfs\.ext4|loop,nofail/);
assert.match(tmpStorage, /install-isolated-runtime\.sh/);
assert.match(isolatedRuntimeInstaller, /mountpoint -q "\$STORAGE_ROOT"/);
assert.match(isolatedRuntimeInstaller, /findmnt -rn -T "\$STORAGE_ROOT" -o SOURCE/);
assert.match(isolatedRuntimeInstaller, /\/etc\/devserver-runtime/);
assert.match(isolatedRuntimeInstaller, /containerd-devserver\.service/);
assert.match(isolatedRuntimeInstaller, /docker-devserver\.service/);
assert.match(composeWrapper, /DOCKER_HOST="unix:\/\/\/run\/docker-devserver\.sock"/);
assert.match(composeWrapper, /DockerRootDir/);
assert.match(storageVerifier, /STORAGE_ROOT="\/srv\/devserver"/);
assert.match(storageVerifier, /DOCKER_SOCKET="unix:\/\/\/run\/docker-devserver\.sock"/);
assert.doesNotMatch(storageVerifier, /readonly DOCKER_HOST=/);
assert.match(storageVerifier, /DOCKER_HOST="\$DOCKER_SOCKET" docker info/);
assert.match(storageVerifier, /\$STORAGE_ROOT\/containerd/);
assert.match(storageVerifier, /\$STORAGE_ROOT\/docker/);
assert.match(storageVerifier, /devserver-cloudflared/);
assert.match(storageVerifier, /system-bridge-check/);
assert.match(containerdConfig, /root = "\/srv\/devserver\/containerd"/);
assert.match(containerdConfig, /state = "\/run\/containerd-devserver"/);
assert.match(containerdConfig, /address = "\/run\/containerd-devserver\/containerd\.sock"/);
assert.match(dockerConfig, /"data-root": "\/srv\/devserver\/docker"/);
assert.match(dockerConfig, /"exec-root": "\/run\/docker-devserver"/);
assert.match(dockerConfig, /"hosts": \["unix:\/\/\/run\/docker-devserver\.sock"\]/);
assert.match(dockerConfig, /"bridge": "br-ds-default"/);
assert.match(dockerConfig, /"iptables": false/);
assert.match(dockerConfig, /"defaultKeepStorage": "8GB"/);
for (const service of [containerdService, dockerService]) {
  assert.match(service, /RequiresMountsFor=\/srv\/devserver/);
  assert.match(service, /ConditionPathIsMountPoint=\/srv\/devserver/);
}
assert.match(dockerService, /Requires=containerd-devserver\.service/);
assert.match(dockerService, /After=.*docker\.service/);
assert.match(dockerService, /Wants=.*docker\.service/);
assert.match(
  dockerService,
  /ExecStartPre=\/usr\/local\/libexec\/devserver-network\.sh daemon-bridge-up/,
);
assert.match(
  dockerService,
  /ExecStartPre=\/usr\/local\/libexec\/devserver-network\.sh system-bridge-check/,
);
assert.match(dockerService, /--containerd=\/run\/containerd-devserver\/containerd\.sock/);
assert.match(networkScript, /172\.30\.250\.0\/24/);
assert.match(networkScript, /br-devserver/);
assert.match(networkScript, /172\.30\.251\.1\/24/);
assert.match(networkScript, /br-ds-default/);
assert.match(networkScript, /daemon-bridge-up/);
assert.match(networkScript, /system-bridge-check/);
assert.match(networkScript, /add_rule filter -i "\$DAEMON_BRIDGE_NAME" -j ACCEPT/);
assert.match(networkScript, /add_rule nat -s "\$DAEMON_BRIDGE_SUBNET"/);
assert.match(networkScript, /ip link add name "\$DAEMON_BRIDGE_NAME" type bridge/);
assert.match(networkScript, /DOCKER-USER/);
assert.match(networkScript, /MASQUERADE/);
assert.match(networkService, /After=docker\.service docker-devserver\.service/);
assert.match(proxySocket, /ListenStream=127\.0\.0\.1:17676/);
assert.match(proxyService, /172\.30\.250\.10:7676/);
assert.match(isolatedRuntimeInstaller, /devserver-maintenance\.sh/);
assert.match(isolatedRuntimeInstaller, /devserver-maintenance\.service/);
assert.match(isolatedRuntimeInstaller, /devserver-maintenance\.timer/);
assert.match(isolatedRuntimeInstaller, /enable --now devserver-maintenance\.timer/);
assert.match(maintenanceScript, /flock -n/);
assert.match(maintenanceScript, /mountpoint -q "\$STORAGE_ROOT"/);
assert.match(maintenanceScript, /findmnt -rn -T "\$STORAGE_ROOT" -o SOURCE/);
assert.match(maintenanceScript, /unix:\/\/\/run\/docker-devserver\.sock/);
assert.match(maintenanceScript, /DockerRootDir/);
assert.match(maintenanceScript, /daemon-bridge-check/);
assert.match(maintenanceScript, /daemon-bridge-up/);
assert.match(maintenanceScript, /system-bridge-check/);
assert.match(maintenanceScript, /df --output=pcent/);
assert.doesNotMatch(maintenanceScript, /df -P --output/);
assert.match(maintenanceScript, /DISK_SOFT_PERCENT:-70/);
assert.match(maintenanceScript, /DISK_HARD_PERCENT:-85/);
assert.match(maintenanceScript, /go-build\*/);
assert.match(maintenanceScript, /sub2api-backup-part-\*/);
assert.match(maintenanceScript, /builder prune/);
assert.match(maintenanceScript, /run_builder_prune/);
assert.match(maintenanceScript, /\.State\.Health\.Status/);
assert.match(maintenanceScript, /"\$health" == "starting"/);
assert.match(maintenanceScript, /docker_devserver restart devserver/);
assert.match(maintenanceScript, /PUBLIC_FAILURE_LIMIT:-3/);
assert.match(maintenanceScript, /memory\.events/);
assert.doesNotMatch(maintenanceScript, /docker_devserver system prune/);
assert.doesNotMatch(maintenanceScript, /volume prune/);
assert.doesNotMatch(maintenanceScript, /rm -rf[^\n]*\.devspace-worktrees/);
assert.match(maintenanceService, /RequiresMountsFor=\/srv\/devserver/);
assert.match(maintenanceService, /ExecStart=\/usr\/local\/libexec\/devserver-maintenance\.sh/);
assert.match(maintenanceService, /IOSchedulingClass=idle/);
assert.match(maintenanceTimer, /OnUnitActiveSec=5min/);
assert.match(maintenanceTimer, /RandomizedDelaySec=30s/);
assert.match(maintenanceTimer, /Persistent=true/);
assert.match(compose, /oom_score_adj:\s*500/);
assert.match(codexConfig, /name = '.*' AND status = 'active'/);
assert.match(codexConfig, /DEVSERVER_HOME="\/srv\/devserver\/runtime\/home"/);
assert.match(codexConfig, /mountpoint -q "\/srv\/devserver"/);
assert.match(codexConfig, /findmnt -rn -T "\/srv\/devserver" -o SOURCE/);
assert.doesNotMatch(codexConfig, /DEVSERVER_HOME:-\/home\/ubuntu\/\.devserver\/home/);
assert.match(codexConfig, /model = "gpt-5\.6-sol"/);
assert.match(codexConfig, /model_reasoning_effort = "xhigh"/);
assert.match(codexConfig, /model_context_window = 1000000/);
assert.match(codexConfig, /model_auto_compact_token_limit = 900000/);
assert.match(codexConfig, /model_provider = "OpenAI"/);
assert.match(codexConfig, /base_url = "https:\/\/api\.tokenlab\.cc\.cd"/);
assert.match(codexConfig, /\[orchestrator\]/);
assert.match(codexConfig, /default_subagent_model = "gpt-5\.6-luna"/);
assert.match(codexConfig, /default_subagent_reasoning_effort = "max"/);
assert.match(codexConfig, /DEVSERVER_CODEX_MAX_CONCURRENT_THREADS:-2/);
assert.match(codexConfig, /max_concurrent_threads_per_session = %s/);
assert.match(codexConfig, /hooks = true/);
assert.match(codexConfig, /memories = true/);
assert.match(codexConfig, /goals = true/);
assert.match(codexConfig, /chronicle = true/);
assert.match(codexConfig, /\[projects\."\/home\/ubuntu\/work"\]/);
assert.match(codexConfig, /trust_level = "trusted"/);
assert.doesNotMatch(codexConfig, /use_legacy_landlock/);
assert.doesNotMatch(codexConfig, /sk-[A-Za-z0-9_-]{8,}/);

for (const tool of ["gh", "shellcheck", "tmux", "zsh", "rust-toolchain", "pnpm@11.25.0", "yarn@1.22.22"]) {
  assert.match(dockerfile, new RegExp(tool), `DevServer image should include ${tool}`);
}
