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

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  maxConcurrentTurns: z.number().int().min(1).max(32).optional(),
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
