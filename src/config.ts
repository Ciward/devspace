import { resolve } from "node:path";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";

export type { ToolMode } from "./config-schema.js";

export interface ServerConfig {
  configDir: string;
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  mcpSessionIdleTimeoutMs: number;
  mcpSessionCleanupIntervalMs: number;
  mcpSessionMaxCount: number;
  toolMode: ToolMode;
  resumableBash: boolean;
  resumableBashYieldMs: number;
  uiEnabled: boolean;
  stateDir: string;
  worktreeRoot: string;
  worktreeMaxCount: number;
  worktreeArchiveRemote: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  subagentMaxConcurrentTurns: number;
  agentDir: string;
  logging: LoggingConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const host = env.HOST?.trim() || stored.server.host;
  const port = parseBoundedInteger(env.PORT, stored.server.port, "PORT", 1, 65_535);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL?.trim()
      || stored.server.publicBaseUrl
      || localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];
  const configuredAllowedHosts = parseStringList(env.DEVSPACE_ALLOWED_HOSTS);
  const configuredAllowedRoots = parseStringList(env.DEVSPACE_ALLOWED_ROOTS);
  const subagentMaxConcurrentTurns = parseBoundedInteger(
    env.DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS,
    stored.subagents.maxConcurrentTurns ?? 4,
    "DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS",
    1,
    32,
  );

  return {
    configDir: files.dir,
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: parseBoundedInteger(
        env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        stored.oauth.accessTokenTtlSeconds,
        "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      refreshTokenTtlSeconds: parseBoundedInteger(
        env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        stored.oauth.refreshTokenTtlSeconds,
        "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES) ?? stored.oauth.scopes,
      allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS)
        ?? stored.oauth.allowedRedirectHosts,
    },
    allowedRoots: normalizePaths(
      configuredAllowedRoots ?? stored.workspaces.allowedRoots,
      [process.cwd()],
    ),
    allowedHosts: normalizeAllowedHosts(configuredAllowedHosts ?? derivedAllowedHosts),
    publicBaseUrl,
    mcpSessionIdleTimeoutMs: parseBoundedInteger(
      env.DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS,
      stored.server.mcpSessionIdleTimeoutMs,
      "DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS",
      30_000,
      24 * 60 * 60 * 1_000,
    ),
    mcpSessionCleanupIntervalMs: parseBoundedInteger(
      env.DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS,
      stored.server.mcpSessionCleanupIntervalMs,
      "DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_MS",
      1_000,
      60 * 60 * 1_000,
    ),
    mcpSessionMaxCount: parseBoundedInteger(
      env.DEVSPACE_MCP_SESSION_MAX_COUNT,
      stored.server.mcpSessionMaxCount,
      "DEVSPACE_MCP_SESSION_MAX_COUNT",
      1,
      10_000,
    ),
    toolMode: parseToolMode(env.DEVSPACE_TOOL_MODE, stored.tools.mode),
    resumableBash: env.DEVSPACE_RESUMABLE_BASH === undefined
      ? stored.tools.resumableBash
      : parseBoolean(env.DEVSPACE_RESUMABLE_BASH),
    resumableBashYieldMs: parseBoundedInteger(
      env.DEVSPACE_RESUMABLE_BASH_YIELD_MS,
      stored.tools.resumableBashYieldMs,
      "DEVSPACE_RESUMABLE_BASH_YIELD_MS",
      0,
      30_000,
    ),
    uiEnabled: parseWidgetEnabled(env.DEVSPACE_WIDGETS, stored.ui.enabled),
    stateDir: normalizePath(env.DEVSPACE_STATE_DIR?.trim() || stored.storage.stateDir),
    worktreeRoot: normalizePath(
      env.DEVSPACE_WORKTREE_ROOT?.trim() || stored.workspaces.worktreeRoot,
    ),
    worktreeMaxCount: parseBoundedInteger(
      env.DEVSPACE_WORKTREE_MAX_COUNT,
      stored.workspaces.worktreeMaxCount,
      "DEVSPACE_WORKTREE_MAX_COUNT",
      0,
      10_000,
    ),
    worktreeArchiveRemote: env.DEVSPACE_WORKTREE_ARCHIVE_REMOTE?.trim()
      || stored.workspaces.worktreeArchiveRemote,
    artifactsEnabled: env.DEVSPACE_ARTIFACTS === undefined
      ? stored.artifacts.enabled
      : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: parseBoundedInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES,
      stored.artifacts.maxFileBytes,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined
      ? stored.skills.enabled
      : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parseStringList(env.DEVSPACE_SKILL_PATHS) ?? stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: {
      ...stored.subagents,
      enabled: env.DEVSPACE_SUBAGENTS === undefined
        ? stored.subagents.enabled
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
      maxConcurrentTurns: subagentMaxConcurrentTurns,
    },
    subagentMaxConcurrentTurns,
    agentDir: normalizePath(env.DEVSPACE_AGENT_DIR?.trim() || stored.skills.agentDir),
    logging: {
      level: parseLogLevel(env.DEVSPACE_LOG_LEVEL, stored.logging.level),
      format: parseLogFormat(env.DEVSPACE_LOG_FORMAT, stored.logging.format),
      requests: parseOptionalBoolean(env.DEVSPACE_LOG_REQUESTS, stored.logging.requests),
      assets: parseOptionalBoolean(env.DEVSPACE_LOG_ASSETS, stored.logging.assets),
      toolCalls: parseOptionalBoolean(env.DEVSPACE_LOG_TOOL_CALLS, stored.logging.toolCalls),
      shellCommands: parseOptionalBoolean(
        env.DEVSPACE_LOG_SHELL_COMMANDS,
        stored.logging.shellCommands,
      ),
      trustProxy: parseOptionalBoolean(env.DEVSPACE_TRUST_PROXY, stored.server.trustProxy),
    },
  };
}

function parseToolMode(value: string | undefined, fallback: ToolMode): ToolMode {
  if (value === undefined || value === "") return fallback;
  if (value === "claude" || value === "codex" || value === "full") return value;
  throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${value}`);
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseOptionalBoolean(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : parseBoolean(value);
}

function parseWidgetEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "off") return false;
  if (value === "changes" || value === "full") return true;
  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseLogLevel(value: string | undefined, fallback: LoggingConfig["level"]): LoggingConfig["level"] {
  if (value === undefined || value === "") return fallback;
  if (["silent", "error", "warn", "info", "debug"].includes(value)) {
    return value as LoggingConfig["level"];
  }
  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined, fallback: LoggingConfig["format"]): LoggingConfig["format"] {
  if (value === undefined || value === "") return fallback;
  if (value === "json" || value === "pretty") return value;
  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: devspace init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
