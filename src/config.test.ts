import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
const env = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

try {
  const defaults = loadConfig(env);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 7676);
  assert.equal(defaults.publicBaseUrl, "http://127.0.0.1:7676");
  assert.deepEqual(defaults.allowedRoots, [process.cwd()]);
  assert.deepEqual(defaults.allowedHosts, ["localhost", "127.0.0.1", "::1"]);
  assert.equal(defaults.toolMode, "codex");
  assert.equal(defaults.uiEnabled, true);
  assert.equal(defaults.skillsEnabled, true);
  assert.equal(defaults.artifactsEnabled, false);
  assert.equal((defaults as unknown as Record<string, unknown>).mcpSessionIdleTimeoutMs, 24 * 60 * 60 * 1_000);
  assert.equal((defaults as unknown as Record<string, unknown>).mcpSessionCleanupIntervalMs, 5 * 60 * 1_000);
  assert.equal((defaults as unknown as Record<string, unknown>).mcpSessionMaxCount, 1_024);
  assert.equal((defaults as unknown as Record<string, unknown>).subagentMaxConcurrentTurns, 4);
  assert.deepEqual(defaults.subagents, { enabled: false, providers: [], maxConcurrentTurns: 4 });
  assert.deepEqual(defaults.logging, {
    level: "info",
    format: "json",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
  });

  writeDevspaceConfig({
    configVersion: 1,
    server: {
      host: "0.0.0.0",
      port: 8787,
      publicBaseUrl: "https://devspace.example.com/",
      allowedHosts: ["example.internal"],
      trustProxy: true,
    },
    workspaces: {
      allowedRoots: ["~/work"],
      worktreeRoot: "~/trees",
    },
    storage: { stateDir: "~/state" },
    tools: { mode: "claude" },
    ui: { enabled: false },
    artifacts: { enabled: true, maxFileBytes: 321 },
    skills: { enabled: false, paths: ["~/skills"], agentDir: "~/agent" },
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
    logging: {
      level: "debug",
      format: "pretty",
      requests: false,
      assets: true,
      toolCalls: false,
      shellCommands: true,
    },
    oauth: {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 240,
      scopes: ["devspace", "admin"],
      allowedRedirectHosts: ["chatgpt.com", "example.com"],
    },
  }, env);
  writeDevspaceAuth({ ownerToken: "persisted-owner-token-long-enough" }, env);

  const configured = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
  assert.equal(configured.configDir, configDir);
  assert.equal(configured.host, "0.0.0.0");
  assert.equal(configured.port, 8787);
  assert.equal(configured.publicBaseUrl, "https://devspace.example.com");
  assert.deepEqual(configured.allowedRoots, [resolve(homedir(), "work")]);
  assert.deepEqual(configured.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "devspace.example.com",
    "example.internal",
  ]);
  assert.equal(configured.toolMode, "claude");
  assert.equal(configured.uiEnabled, false);
  assert.equal(configured.stateDir, resolve(homedir(), "state"));
  assert.equal(configured.worktreeRoot, resolve(homedir(), "trees"));
  assert.equal(configured.artifactsEnabled, true);
  assert.equal(configured.artifactMaxFileBytes, 321);
  assert.equal(configured.skillsEnabled, false);
  assert.deepEqual(configured.skillPaths, ["~/skills"]);
  assert.equal(configured.agentDir, resolve(homedir(), "agent"));
  assert.equal(configured.subagents.enabled, true);
  assert.equal(configured.oauth.ownerToken, "persisted-owner-token-long-enough");
  assert.equal(configured.oauth.accessTokenTtlSeconds, 120);
  assert.deepEqual(configured.oauth.scopes, ["devspace", "admin"]);
  assert.deepEqual(configured.logging, {
    level: "debug",
    format: "pretty",
    requests: false,
    assets: true,
    toolCalls: false,
    shellCommands: true,
    trustProxy: true,
  });

  assert.equal(loadConfig(env).oauth.ownerToken, env.DEVSPACE_OAUTH_OWNER_TOKEN);
  const limited = loadConfig({
    ...env,
    HOST: "0.0.0.0",
    PORT: "6767",
    DEVSPACE_PUBLIC_BASE_URL: "https://env.devspace.example.com/",
    DEVSPACE_ALLOWED_HOSTS: "localhost,env.devspace.example.com",
    DEVSPACE_ALLOWED_ROOTS: "~/env-work,~/env-projects",
    DEVSPACE_STATE_DIR: "~/env-state",
    DEVSPACE_WORKTREE_ROOT: "~/env-trees",
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_SKILLS: "1",
    DEVSPACE_ARTIFACTS: "0",
    DEVSPACE_TRUST_PROXY: "1",
    DEVSPACE_LOG_FORMAT: "pretty",
    DEVSPACE_LOG_TOOL_CALLS: "1",
    DEVSPACE_LOG_SHELL_COMMANDS: "0",
    DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: "300000",
    DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS: "30000",
    DEVSPACE_MCP_SESSION_MAX_COUNT: "128",
    DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS: "2",
  });
  assert.equal((limited as unknown as Record<string, unknown>).mcpSessionIdleTimeoutMs, 300_000);
  assert.equal((limited as unknown as Record<string, unknown>).mcpSessionCleanupIntervalMs, 30_000);
  assert.equal((limited as unknown as Record<string, unknown>).mcpSessionMaxCount, 128);
  assert.equal((limited as unknown as Record<string, unknown>).subagentMaxConcurrentTurns, 2);
  assert.equal(limited.host, "0.0.0.0");
  assert.equal(limited.port, 6767);
  assert.equal(limited.publicBaseUrl, "https://env.devspace.example.com");
  assert.deepEqual(limited.allowedHosts, ["localhost", "env.devspace.example.com"]);
  assert.deepEqual(limited.allowedRoots, [
    resolve(homedir(), "env-work"),
    resolve(homedir(), "env-projects"),
  ]);
  assert.equal(limited.stateDir, resolve(homedir(), "env-state"));
  assert.equal(limited.worktreeRoot, resolve(homedir(), "env-trees"));
  assert.equal(limited.uiEnabled, true);
  assert.equal(limited.skillsEnabled, true);
  assert.equal(limited.artifactsEnabled, false);
  assert.deepEqual(limited.logging, {
    level: "debug",
    format: "pretty",
    requests: false,
    assets: true,
    toolCalls: true,
    shellCommands: false,
    trustProxy: true,
  });
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

const missingAuthDir = mkdtempSync(join(tmpdir(), "devspace-config-no-auth-test-"));
try {
  assert.throws(
    () => loadConfig({ DEVSPACE_CONFIG_DIR: missingAuthDir }),
    /OAuth owner token is required/,
  );
} finally {
  rmSync(missingAuthDir, { recursive: true, force: true });
}

console.log("config tests passed");
