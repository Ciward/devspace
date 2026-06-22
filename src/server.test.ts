import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessSummary, createServer, formatAccessSummary, toolNamesFor } from "./server.js";
import type { ServerConfig } from "./config.js";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 7676,
  publicBaseUrl: "https://devspace.example.com",
  allowedRoots: [
    "/Users/alice/work",
    "/Users/alice/personal/open-source",
  ],
  allowedHosts: ["localhost", "127.0.0.1", "::1", "devspace.example.com"],
  minimalTools: true,
  toolNaming: "short",
  widgets: "full",
  stateDir: "/Users/alice/.local/share/devspace",
  worktreeRoot: "/Users/alice/.devspace/worktrees",
  skillsEnabled: true,
  skillPaths: [],
  agentDir: "/Users/alice/.codex",
  logging: {
    level: "info",
    format: "json",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
  },
  oauth: {
    ownerToken: "test-owner-token-that-is-long-enough",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
  },
};

const summary = accessSummary(config);
assert.equal(summary.publicMcpUrl, "https://devspace.example.com/mcp");
assert.deepEqual(summary.allowedRoots, [
  "/Users/alice/work",
  "/Users/alice/personal/open-source",
]);
assert.deepEqual(summary.openWorkspaceExamples, [
  {
    path: "/Users/alice/work",
    mode: "checkout",
  },
  {
    path: "/Users/alice/personal/open-source",
    mode: "checkout",
  },
  {
    path: "/Users/alice/work",
    mode: "worktree",
  },
]);

const formatted = formatAccessSummary(summary);
assert.match(formatted, /Accessible local workspace roots:/);
assert.match(formatted, /- \/Users\/alice\/work/);
assert.match(formatted, /Public MCP endpoint: https:\/\/devspace\.example\.com\/mcp/);
assert.match(formatted, /Managed Git worktrees are created under: \/Users\/alice\/\.devspace\/worktrees/);
assert.match(formatted, /open_workspace with \{"path":"\/Users\/alice\/work"\}/);
assert.match(formatted, /open_workspace with \{"path":"\/Users\/alice\/work","mode":"worktree"\}/);

assert.equal(toolNamesFor(config).workspaceInfo, "workspace_info");
assert.equal(toolNamesFor({ ...config, toolNaming: "legacy" }).workspaceInfo, "workspace_info");

const stateDir = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
const proxiedServer = createServer({
  ...config,
  stateDir,
  logging: {
    ...config.logging,
    trustProxy: true,
  },
});
try {
  assert.equal(proxiedServer.app.get("trust proxy"), "loopback");
} finally {
  proxiedServer.close();
}
