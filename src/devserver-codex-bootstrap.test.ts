import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const bootstrap = new URL("../deploy/devserver/codex-bootstrap.sh", import.meta.url).pathname;

async function makeCodex(path: string, version: string): Promise<void> {
  await mkdir(join(path, "bin"), { recursive: true });
  await writeFile(
    join(path, "bin", "codex"),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo "codex-cli ${version}"; exit 0; fi\nif [[ "\${1:-}" == "app-server" && "\${2:-}" == "--help" ]]; then exit 0; fi\nexit 1\n`,
  );
  await chmod(join(path, "bin", "codex"), 0o755);
}

async function makeFakeNpm(path: string, viewResult?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "view" ]]; then
  ${viewResult ? `printf '%s\\n' '${viewResult}'` : "exit 1"}
  exit 0
fi
if [[ "\${1:-}" == "install" ]]; then
  prefix=""
  package=""
  while (($#)); do
    case "$1" in
      --prefix) prefix="$2"; shift 2 ;;
      @openai/codex@*) package="$1"; shift ;;
      *) shift ;;
    esac
  done
  version="\${package##*@}"
  mkdir -p "$prefix/bin"
  cat >"$prefix/bin/codex" <<EOF
#!/usr/bin/env bash
if [[ "\\\${1:-}" == "--version" ]]; then echo "codex-cli $version"; exit 0; fi
if [[ "\\\${1:-}" == "app-server" && "\\\${2:-}" == "--help" ]]; then exit 0; fi
exit 1
EOF
  chmod +x "$prefix/bin/codex"
  exit 0
fi
exit 1
`,
  );
  await chmod(join(path, "npm"), 0o755);
}

async function runBootstrap(options: {
  home: string;
  npmBin: string;
  fallback: string;
}): Promise<string> {
  const { stdout } = await execFileAsync(
    bootstrap,
    ["bash", "-c", "printf '%s' \"$CODEX_COMMAND\""],
    {
      env: {
        ...process.env,
        HOME: options.home,
        PATH: `${options.npmBin}:/usr/bin:/bin`,
        DEVSERVER_CODEX_FALLBACK: options.fallback,
        DEVSERVER_CODEX_UPDATE_TIMEOUT_SECONDS: "5",
      },
    },
  );
  return stdout.trim();
}

{
  const root = await mkdtemp(join(tmpdir(), "devserver-codex-update-"));
  const home = join(root, "home");
  const fallback = join(root, "fallback", "bin", "codex");
  const npmBin = join(root, "fake-bin");
  await makeCodex(join(root, "fallback"), "0.149.1");
  await makeFakeNpm(npmBin, "9.9.9");

  const selected = await runBootstrap({ home, npmBin, fallback });

  assert.equal(selected, join(home, ".npm-global", "current", "bin", "codex"));
  assert.match(await readFile(selected, "utf8"), /codex-cli 9\.9\.9/);
}

{
  const root = await mkdtemp(join(tmpdir(), "devserver-codex-fallback-"));
  const home = join(root, "home");
  const fallback = join(root, "fallback", "bin", "codex");
  const npmBin = join(root, "fake-bin");
  await makeCodex(join(root, "fallback"), "0.149.1");
  await makeFakeNpm(npmBin);

  assert.equal(await runBootstrap({ home, npmBin, fallback }), fallback);
}

{
  const root = await mkdtemp(join(tmpdir(), "devserver-codex-existing-"));
  const home = join(root, "home");
  const fallback = join(root, "fallback", "bin", "codex");
  const npmBin = join(root, "fake-bin");
  const version = join(home, ".npm-global", "versions", "8.8.8");
  await makeCodex(join(root, "fallback"), "0.149.1");
  await makeCodex(version, "8.8.8");
  await mkdir(join(home, ".npm-global"), { recursive: true });
  await symlink(version, join(home, ".npm-global", "current"));
  await makeFakeNpm(npmBin);

  assert.equal(
    await runBootstrap({ home, npmBin, fallback }),
    join(home, ".npm-global", "current", "bin", "codex"),
  );
}
