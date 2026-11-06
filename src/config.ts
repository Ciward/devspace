import { resolve } from "node:path";
import { parsePublicOrigin } from "./public-origins.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles, type DevspaceFiles } from "./user-config.js";
import {
  disabledSubagentsConfig,
  implicitSubagentsConfig,
  resolveSubagentsConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";

/** What `devspace agents` and the agent daemon need. They run without OAuth, a public URL, or a server. */
export interface AgentConfig {
  configDir: string;
  allowedRoots: string[];
  stateDir: string;
  worktreeRoot: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
}

export interface ServerConfig extends AgentConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedHosts: string[];
  publicBaseUrl: string;
  publicBaseUrlAliases: string[];
  worktreeMaxCount: number;
  worktreeArchiveRemote: string;
  /** Explicit `tools.mode`; when set it wins over host detection. */
  toolSurfaceOverride: "claude" | "codex" | "full" | undefined;
  resumableBash: boolean;
  resumableBashYieldMs: number;
  mcpJsonResponses: boolean;
  experimentalCodeMode: boolean;
  uiEnabled: boolean;
  activity: { enabled: boolean; maxTurns: number };
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  logging: LoggingConfig;
}

/**
 * Agent commands need no server setup. Without a `subagents` key they detect the installed
 * coding agents; an explicit `subagents` config, including `enabled: false`, always wins.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const files = loadDevspaceFiles(env);
  const { subagents } = files.config;

  return agentConfig(files, env, subagents ? resolveSubagentsConfig(subagents) : implicitSubagentsConfig());
}

function agentConfig(files: DevspaceFiles, env: NodeJS.ProcessEnv, subagents: SubagentsConfig): AgentConfig {
  const stored = files.config;

  return {
    configDir: files.dir,
    allowedRoots: normalizePaths(parseList(env.DEVSPACE_ALLOWED_ROOTS) ?? stored.workspaces.allowedRoots, [process.cwd()]),
    stateDir: normalizePath(env.DEVSPACE_STATE_DIR?.trim() || stored.storage.stateDir),
    worktreeRoot: normalizePath(env.DEVSPACE_WORKTREE_ROOT?.trim() || stored.workspaces.worktreeRoot),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents,
    agentDir: normalizePath(stored.skills.agentDir),
  };
}

/** Strict config for `devspace serve`: requires the owner token. Subagents stay an explicit opt-in. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const subagents = resolveSubagentsConfig(stored.subagents ?? disabledSubagentsConfig());
  if (env.DEVSPACE_SUBAGENTS !== undefined) subagents.enabled = parseBoolean(env.DEVSPACE_SUBAGENTS);
  if (env.DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS !== undefined) {
    subagents.maxConcurrentTurns = parseInteger(env.DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS, "DEVSPACE_SUBAGENT_MAX_CONCURRENT_TURNS", 1, 32);
  }
  const host = env.HOST?.trim() || stored.server.host;
  const port = env.PORT === undefined ? stored.server.port : parseInteger(env.PORT, "PORT", 1, 65_535);

  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL?.trim() || stored.server.publicBaseUrl || localPublicBaseUrl(host, port),
  );
  const publicBaseUrlAliases = [...new Set((env.DEVSPACE_PUBLIC_BASE_URL_ALIASES === undefined
    ? stored.server.publicBaseUrlAliases
    : env.DEVSPACE_PUBLIC_BASE_URL_ALIASES.split(",").map((value) => value.trim()).filter(Boolean)).map(
    (value) => parsePublicOrigin(value, "publicBaseUrlAliases"),
  ))];

  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...publicBaseUrlAliases.map((value) => new URL(value).hostname),
    ...stored.server.allowedHosts,
  ];

  return {
    ...agentConfig(files, env, subagents),
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS === undefined
        ? stored.oauth.accessTokenTtlSeconds : parseInteger(env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 1),
      refreshTokenTtlSeconds: env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS === undefined
        ? stored.oauth.refreshTokenTtlSeconds : parseInteger(env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS", 1),
      refreshTokenGraceSeconds: stored.oauth.refreshTokenGraceSeconds,
      scopes: parseList(env.DEVSPACE_OAUTH_SCOPES) ?? stored.oauth.scopes,
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: parseList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS) ?? stored.oauth.allowedRedirectHosts,
    },
    allowedHosts: normalizeAllowedHosts(parseList(env.DEVSPACE_ALLOWED_HOSTS) ?? derivedAllowedHosts),
    publicBaseUrl,
    publicBaseUrlAliases,
    worktreeMaxCount: env.DEVSPACE_WORKTREE_MAX_COUNT === undefined
      ? stored.workspaces.worktreeMaxCount : parseInteger(env.DEVSPACE_WORKTREE_MAX_COUNT, "DEVSPACE_WORKTREE_MAX_COUNT", 0, 10_000),
    worktreeArchiveRemote: env.DEVSPACE_WORKTREE_ARCHIVE_REMOTE?.trim() || stored.workspaces.worktreeArchiveRemote,
    toolSurfaceOverride: env.DEVSPACE_TOOL_MODE === undefined
      ? stored.tools.mode : zToolMode(env.DEVSPACE_TOOL_MODE),
    resumableBash: env.DEVSPACE_RESUMABLE_BASH === undefined
      ? stored.tools.resumableBash : parseBoolean(env.DEVSPACE_RESUMABLE_BASH),
    resumableBashYieldMs: env.DEVSPACE_RESUMABLE_BASH_YIELD_MS === undefined
      ? stored.tools.resumableBashYieldMs : parseInteger(env.DEVSPACE_RESUMABLE_BASH_YIELD_MS, "DEVSPACE_RESUMABLE_BASH_YIELD_MS", 0, 30_000),
    mcpJsonResponses: env.DEVSPACE_MCP_JSON_RESPONSES === undefined
      ? stored.server.mcpJsonResponses : parseBoolean(env.DEVSPACE_MCP_JSON_RESPONSES),
    experimentalCodeMode: env.DEVSPACE_EXPERIMENTAL_CODE_MODE === "1",
    uiEnabled: env.DEVSPACE_WIDGETS === undefined ? stored.ui.enabled : env.DEVSPACE_WIDGETS !== "off",
    activity: stored.activity,
    artifactsEnabled: env.DEVSPACE_ARTIFACTS === undefined ? stored.artifacts.enabled : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? stored.skills.enabled : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parseList(env.DEVSPACE_SKILL_PATHS) ?? stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    logging: {
      ...stored.logging,
      trustProxy: env.DEVSPACE_TRUST_PROXY === undefined ? stored.server.trustProxy : parseBoolean(env.DEVSPACE_TRUST_PROXY),
    },
  };
}

function parseList(value: string | undefined): string[] | undefined {
  return value?.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function zToolMode(value: string): "claude" | "codex" | "full" {
  if (value === "claude" || value === "codex" || value === "full") return value;
  throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${value}`);
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];

  return Array.from(new Set(hosts.flatMap((host) => {
    const trimmed = host.trim();

    return trimmed ? [trimmed] : [];
  })));
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
  return parsePublicOrigin(value);
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;

  return `http://${formattedHost}:${port}`;
}
