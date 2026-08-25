import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const providerSchema = z.object({
  id: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  allowOverrides: z.boolean().optional(),
}).strict().superRefine((value, context) => {
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

const subagentsSchema = z.object({
  enabled: z.boolean(),
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

export type SubagentProviderConfig = z.infer<typeof providerSchema>;
export type SubagentsConfig = z.infer<typeof subagentsSchema>;
export type StoredSubagentsConfig = boolean | SubagentsConfig;

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

export function resolveSubagentsConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SubagentsConfig {
  const stored = value === undefined
    ? { enabled: false, providers: [] }
    : typeof value === "boolean"
      ? legacySubagentsConfig(value)
      : subagentsSchema.parse(value);
  return {
    ...stored,
    enabled: env.DEVSPACE_SUBAGENTS === undefined
      ? stored.enabled
      : parseBoolean(env.DEVSPACE_SUBAGENTS),
  };
}

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

function legacySubagentsConfig(enabled: boolean): SubagentsConfig {
  return {
    enabled,
    providers: enabled
      ? LOCAL_AGENT_PROVIDERS.map((id) => ({ id, enabled: true }))
      : [],
  };
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
