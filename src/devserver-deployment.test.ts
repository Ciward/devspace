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

const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
const npmCi = dockerfile.indexOf("RUN npm ci");
const vcsArgument = dockerfile.indexOf("ARG DEVSERVER_VCS_REF");
const runtimeToolchain = dockerfile.indexOf("RUN apt-get update");
assert.notEqual(scriptsCopy, -1, "Docker build must copy postinstall scripts before npm ci");
assert.ok(scriptsCopy < npmCi, "Docker build must copy postinstall scripts before npm ci");
assert.ok(
  vcsArgument > runtimeToolchain,
  "Changing only the deployed revision must not invalidate the runtime toolchain layer",
);

assert.match(compose, /pids_limit:\s*4096/);
assert.match(compose, /cloudflare\/cloudflared:2026\.8\.2@sha256:/);
assert.ok(
  compose.includes("${DEVSERVER_WORK_ROOT:-/home/ubuntu/work}:/home/ubuntu/work"),
  "Compose must preserve the server and container workspace path",
);
assert.match(compose, /DEVSPACE_SUBAGENTS:\s*"1"/);
assert.match(compose, /DEVSPACE_TOOL_MODE:\s*full/);
assert.match(compose, /DEVSPACE_WIDGETS:\s*full/);
assert.match(compose, /TMPDIR:\s*\/tmp/);
assert.match(compose, /GOTMPDIR:\s*\/tmp/);
assert.ok(
  compose.includes("${DEVSERVER_TMP_ROOT:-/home/ubuntu/.devserver/tmp80}:/tmp"),
  "Compose must mount the dedicated 80 GiB disk-backed filesystem at /tmp",
);
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
assert.match(dockerfile, /ln -s \/opt\/devspace\/dist\/cli\.js \/usr\/local\/bin\/devspace/);
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
assert.match(tmpStorage, /TMP_SIZE_GIB="80"/);
assert.match(tmpStorage, /truncate -s "\$\{TMP_SIZE_GIB\}G"/);
assert.match(tmpStorage, /mkfs\.ext4/);
assert.match(tmpStorage, /loop,nofail,nodev,nosuid/);
assert.match(tmpStorage, /chmod 01777/);
assert.match(codexConfig, /name = '.*' AND status = 'active'/);
assert.match(codexConfig, /model = "gpt-5\.6-sol"/);
assert.match(codexConfig, /model_reasoning_effort = "xhigh"/);
assert.match(codexConfig, /model_context_window = 1000000/);
assert.match(codexConfig, /model_auto_compact_token_limit = 900000/);
assert.match(codexConfig, /model_provider = "OpenAI"/);
assert.match(codexConfig, /base_url = "https:\/\/api\.tokenlab\.cc\.cd"/);
assert.match(codexConfig, /\[orchestrator\]/);
assert.match(codexConfig, /default_subagent_model = "gpt-5\.6-luna"/);
assert.match(codexConfig, /default_subagent_reasoning_effort = "max"/);
assert.match(codexConfig, /max_concurrent_threads_per_session = 6/);
assert.match(codexConfig, /hooks = true/);
assert.match(codexConfig, /memories = true/);
assert.match(codexConfig, /goals = true/);
assert.match(codexConfig, /chronicle = true/);
assert.match(codexConfig, /\[projects\."\/home\/ubuntu\/work"\]/);
assert.match(codexConfig, /trust_level = "trusted"/);
assert.doesNotMatch(codexConfig, /use_legacy_landlock/);
assert.doesNotMatch(codexConfig, /sk-[A-Za-z0-9_-]{8,}/);

for (const tool of ["gh", "shellcheck", "tmux", "zsh", "rust-toolchain", "pnpm@10.23.0", "yarn@1.22.22"]) {
  assert.match(dockerfile, new RegExp(tool), `DevServer image should include ${tool}`);
}
