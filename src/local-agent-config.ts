import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string(),
);

const providerShape = {
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  allowOverrides: z.boolean().optional(),
  env: environmentSchema.optional(),
};

const commandSchema = z.string()
  .regex(/\S/, "Command must contain a non-whitespace character")
  .trim()
  .min(1)
  .optional();

const providerSchema = z.discriminatedUnion("id", [
  z.object({
    id: z.enum(["codex", "claude", "cursor", "copilot", "grok"]),
    ...providerShape,
    command: commandSchema,
  }).strict(),
  z.object({
    id: z.enum(["opencode", "pi"]),
    ...providerShape,
  }).strict(),
]).superRefine((value, context) => {
  if (value.allowOverrides !== false) return;
  if (!value.model) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "Subagent provider model is required when allowOverrides is false",
    });
  }
  if (!value.effort) {
    context.addIssue({
      code: "custom",
      path: ["effort"],
      message: "Subagent provider effort is required when allowOverrides is false",
    });
  }
});

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  maxConcurrentTurns: z.number().int().min(1).max(32).optional(),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  providers: z.array(providerSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProvider>();
  for (const [index, provider] of value.providers.entries()) {
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate subagent provider: ${provider.id}`,
      });
    }
    seen.add(provider.id);
  }
});

export const storedSubagentsConfigSchema = z.union([
  z.boolean(),
  subagentsConfigSchema,
]);

export type SubagentProviderConfig = z.infer<typeof providerSchema>;
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
export type StoredSubagentsConfig = z.infer<typeof storedSubagentsConfigSchema>;

export function subagentProviderConfig(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === provider);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): boolean {
  return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}

export function localAgentProviderEnvironment(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const providerConfig = subagentProviderConfig(config, provider);
  const env = { ...inherited, ...providerConfig?.env };
  const commandVariable = providerCommandVariable(provider);
  const command = providerConfig && "command" in providerConfig ? providerConfig.command : undefined;
  if (commandVariable && command) env[commandVariable] = command;
  return env;
}

export function localAgentProviderEnvironmentOverrides(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): Record<string, string> {
  return { ...subagentProviderConfig(config, provider)?.env };
}

export function providerCommandVariable(provider: LocalAgentProvider): string | undefined {
  switch (provider) {
    case "codex": return "CODEX_COMMAND";
    case "claude": return "CLAUDE_COMMAND";
    case "cursor": return "CURSOR_COMMAND";
    case "copilot": return "COPILOT_COMMAND";
    case "grok": return "GROK_COMMAND";
    case "opencode":
    case "pi":
      return undefined;
  }
}

export function localAgentProviderConfigRevision(config: SubagentsConfig): string {
  const providers = [...config.providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      allowOverrides: provider.allowOverrides,
      ...(provider.model ? { model: provider.model } : {}),
      ...(provider.effort ? { effort: provider.effort } : {}),
      ...("command" in provider && provider.command ? { command: provider.command } : {}),
      ...(provider.env && Object.keys(provider.env).length > 0
        ? {
            env: Object.fromEntries(
              Object.entries(provider.env).sort(([left], [right]) => left.localeCompare(right)),
            ),
          }
        : {}),
    }));
  return createHash("sha256")
    .update(JSON.stringify({ enabled: config.enabled, maxConcurrentTurns: config.maxConcurrentTurns, providers }))
    .digest("hex");
}

export interface SubagentPolicyViolation {
  field: "model" | "effort";
  configured: string;
  requested: string;
}

export interface SubagentSelection {
  model?: string;
  effort?: string;
  policyViolation?: SubagentPolicyViolation;
}


export function resolveSubagentSelection(
  provider: SubagentProviderConfig | undefined,
  input: {
    profileModel?: string;
    profileEffort?: string;
    modelOverride?: string;
    effortOverride?: string;
  },
): SubagentSelection {
  if (provider?.allowOverrides !== false) {
    return {
      model: input.modelOverride ?? input.profileModel ?? provider?.model,
      effort: input.effortOverride ?? input.profileEffort ?? provider?.effort,
    };
  }

  const model = provider.model!;
  const effort = provider.effort!;
  for (const requestedModel of [input.modelOverride, input.profileModel]) {
    if (requestedModel && requestedModel !== model) {
      return {
        model,
        effort,
        policyViolation: { field: "model", configured: model, requested: requestedModel },
      };
    }
  }
  for (const requestedEffort of [input.effortOverride, input.profileEffort]) {
    if (requestedEffort && requestedEffort !== effort) {
      return {
        model,
        effort,
        policyViolation: { field: "effort", configured: effort, requested: requestedEffort },
      };
    }
  }
  return { model, effort };
}
