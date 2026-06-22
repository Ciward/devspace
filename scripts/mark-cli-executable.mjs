#!/usr/bin/env node
import { chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(scriptDir, "..", "dist", "cli.js");
const currentMode = statSync(cliPath).mode;

chmodSync(cliPath, currentMode | 0o755);
