import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveSubagentSelection,
  type SubagentPolicyViolation,
  type SubagentProviderConfig,
} from "./local-agent-config.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      policyViolation?: SubagentPolicyViolation;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      policyViolation?: SubagentPolicyViolation;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] "<prompt>"',
  );
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] "<prompt>"',
  );
  return { agentId: parsed.target, prompt: parsed.prompt, model: parsed.model, effort: parsed.effort };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--model") {
      const value = parseOptionValue(rest[index + 1], "--model");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = parseOptionValue(part.slice("--model=".length), "--model");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = parseOptionValue(rest[index + 1], "--effort");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = parseOptionValue(part.slice("--effort=".length), "--effort");
      effort = value;
      continue;
    }
    if (part?.startsWith("-")) {
      throw unknownOptionError(part);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort };
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${option}.`);
  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);
  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
    const selection = resolveSubagentSelection(providerConfig, {
      profileModel: profile.model,
      profileEffort: profile.effort,
      modelOverride,
      effortOverride,
    });
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: selection.model,
      effort: selection.effort,
      policyViolation: selection.policyViolation,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    const providerConfig = providerConfigs.find((entry) => entry.id === target);
    const selection = resolveSubagentSelection(providerConfig, { modelOverride, effortOverride });
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: selection.model,
      effort: selection.effort,
      policyViolation: selection.policyViolation,
    };
  }

  return undefined;
}
