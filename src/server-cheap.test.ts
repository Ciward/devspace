import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import {
  accessSummary,
  createServer,
  formatAccessSummary,
  listProjectCandidates,
  openWorkspaceDescription,
  openWorkspaceErrorText,
  openWorkspacePathDescription,
  toolNamesFor,
} from "./server.js";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 7676,
  publicBaseUrl: "https://devspace.example.com",
  allowedRoots: [
    "/Users/alice/work",
    "/Users/alice/personal/open-source",
  ],
  allowedHosts: ["localhost", "127.0.0.1", "::1", "devspace.example.com"],
  toolMode: "minimal",
  widgets: "full",
  stateDir: "/Users/alice/.local/share/devspace",
  worktreeRoot: "/Users/alice/.devspace/worktrees",
  worktreeMaxCount: 10,
  worktreeArchiveRemote: "origin",
  artifactsEnabled: false,
  artifactMaxFileBytes: 100 * 1024 * 1024,
  skillsEnabled: true,
  skillPaths: [],
  devspaceSkillsDir: "/Users/alice/.devspace/skills",
  devspaceAgentsDir: "/Users/alice/.devspace/agents",
  subagents: { enabled: false, providers: [] },
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
assert.match(formatted, /Managed worktree limit: 10/);
assert.match(formatted, /Worktree archive remote: origin/);
assert.match(formatted, /open_workspace with \{"path":"\/Users\/alice\/work"\}/);
assert.match(formatted, /open_workspace with \{"path":"\/Users\/alice\/work","mode":"worktree"\}/);
assert.match(formatted, /STRICT WEB-ONLY EXECUTION POLICY/);
assert.match(formatted, /Completed with ChatGPT Web \+ DevSpace/);
assert.match(formatted, /Completed with Claude Web \+ DevSpace/);
assert.match(formatted, /Git lifecycle writes are explicitly allowed/i);
assert.match(formatted, /git add, commit, push/i);

assert.equal(toolNamesFor(config).workspaceInfo, "workspace_info");
assert.equal(toolNamesFor(config).listProjects, "list_projects");
assert.equal(toolNamesFor(config).completeWorkspace, "complete_workspace");

assert.match(openWorkspaceDescription(config, toolNamesFor(config)), /\/Users\/alice\/work/);
assert.match(openWorkspaceDescription(config, toolNamesFor(config)), /list_projects/);
assert.match(openWorkspacePathDescription(config), /\/Users\/alice\/work/);
assert.match(openWorkspacePathDescription(config), /Do not use "~"/);
assert.match(
  openWorkspaceErrorText(config, "~", new Error("Path is outside allowed roots: ~"), toolNamesFor(config)),
  /Call list_projects first/,
);

const projectsRoot = await mkdtemp(join(tmpdir(), "devspace-projects-test-"));
try {
  await mkdir(join(projectsRoot, "alpha-app", ".git"), { recursive: true });
  await writeFile(join(projectsRoot, "alpha-app", "package.json"), "{}\n");
  await mkdir(join(projectsRoot, "beta-lib"));
  await mkdir(join(projectsRoot, ".hidden"));

  const projects = await listProjectCandidates({
    ...config,
    allowedRoots: [projectsRoot],
  });

  assert.deepEqual(projects.map((project) => project.name), ["alpha-app", "beta-lib"]);
  assert.equal(projects[0]?.path, join(projectsRoot, "alpha-app"));
  assert.deepEqual(projects[0]?.markers, [".git", "package.json"]);
} finally {
  await rm(projectsRoot, { recursive: true, force: true });
}

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
  await proxiedServer.close();
}
