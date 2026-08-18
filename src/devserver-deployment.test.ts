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

const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
const npmCi = dockerfile.indexOf("RUN npm ci");
assert.notEqual(scriptsCopy, -1, "Docker build must copy postinstall scripts before npm ci");
assert.ok(scriptsCopy < npmCi, "Docker build must copy postinstall scripts before npm ci");

assert.match(compose, /pids_limit:\s*4096/);
assert.ok(
  compose.includes("${DEVSERVER_WORK_ROOT:-/home/ubuntu/work}:/home/ubuntu/work"),
  "Compose must preserve the server and container workspace path",
);
assert.match(compose, /DEVSPACE_SUBAGENTS:\s*"0"/);
assert.doesNotMatch(compose, /docker\.sock/);
