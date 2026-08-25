import { resolveSubagentSelection, type SubagentsConfig } from "./local-agent-config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProfileSummary,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export interface LocalAgentProviderStatus {
  id: LocalAgentProvider;
  enabled: boolean;
  available: boolean;
  usable: boolean;
  model?: string;
  effort?: string;
  allowOverrides?: boolean;
  reason?: string;
  note?: string;
}

export interface LocalAgentCatalog {
  enabled: boolean;
  providers: LocalAgentProviderStatus[];
  profiles: LocalAgentProfileSummary[];
}

export function buildLocalAgentProviderStatuses(
  config: SubagentsConfig,
  availability: readonly LocalAgentProviderAvailability[],
): LocalAgentProviderStatus[] {
  return LOCAL_AGENT_PROVIDERS.map((id) => {
    const configured = config.providers.find((entry) => entry.id === id);
    const live = availability.find((entry) => entry.name === id);
    const enabled = configured?.enabled === true;
    const available = live?.available === true;
    return {
      id,
      enabled,
      available,
      usable: config.enabled && enabled && available,
      model: configured?.model,
      effort: configured?.effort,
      allowOverrides: configured?.allowOverrides,
      reason: live?.reason,
      note: live?.note,
    };
  });
}

export function buildLocalAgentCatalog(
  config: SubagentsConfig,
  profiles: readonly LocalAgentProfile[],
  providers: readonly LocalAgentProviderStatus[],
): LocalAgentCatalog {
  const visibleProviders = providers.filter((provider) => provider.enabled);
  const usable = new Map(
    visibleProviders.filter((provider) => provider.usable).map((provider) => [provider.id, provider]),
  );
  return {
    enabled: config.enabled,
    providers: visibleProviders,
    profiles: profiles
      .filter((profile) => {
        if (profile.disabled || !usable.has(profile.provider)) return false;
        const provider = config.providers.find((entry) => entry.id === profile.provider);
        return resolveSubagentSelection(provider, {
          profileModel: profile.model,
          profileEffort: profile.effort,
        }).policyViolation === undefined;
      })
      .map((profile) => {
        const provider = usable.get(profile.provider)!;
        const configured = config.providers.find((entry) => entry.id === profile.provider);
        const selection = resolveSubagentSelection(configured, {
          profileModel: profile.model,
          profileEffort: profile.effort,
        });
        return {
          name: profile.name,
          description: profile.description,
          provider: profile.provider,
          model: selection.model ?? provider.model,
          effort: selection.effort ?? provider.effort,
        };
      }),
  };
}

export function formatLocalAgentProviderStatusSummary(
  providers: readonly LocalAgentProviderStatus[],
): string {
  return providers.map((provider) => {
    const state = provider.usable
      ? "usable"
      : !provider.enabled
        ? "disabled"
        : !provider.available
          ? `unavailable: ${provider.reason ?? "provider preflight failed"}`
          : "subagents disabled";
    return `${provider.id} (${state})`;
  }).join(", ");
}
