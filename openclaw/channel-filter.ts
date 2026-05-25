import type { ProfileDatabase } from "@hent-ai/shared/db";

export type LegacyChannelFilterMode = "allowlist" | "blocklist";

export interface ChannelFilterConfig {
  /** Preferred default for channels without an explicit override. Defaults to true. */
  defaultEnabled?: boolean;
  /** Preferred per-channel source of truth for config-only deployments. */
  overrides?: Record<string, boolean>;
  /** @deprecated Use defaultEnabled + overrides instead. */
  mode?: LegacyChannelFilterMode;
  /** @deprecated Use defaultEnabled + overrides instead. */
  list?: string[];
}

export interface ChannelEnableStore {
  getChannelEnabled(channelId: string): boolean | null;
}

export function normalizeDiscordChannelId(value: string): string {
  return value.startsWith("channel:") ? value.slice(8) : value;
}

function normalizeBooleanOverrides(overrides?: Record<string, boolean>): Map<string, boolean> {
  const normalized = new Map<string, boolean>();
  if (!overrides) return normalized;

  for (const [channelId, enabled] of Object.entries(overrides)) {
    if (typeof enabled === "boolean") {
      normalized.set(normalizeDiscordChannelId(channelId), enabled);
    }
  }

  return normalized;
}

function resolveLegacyDefault(config?: ChannelFilterConfig): boolean | undefined {
  if (!config || config.defaultEnabled !== undefined || config.overrides) return undefined;
  if (config.mode === "allowlist") return false;
  if (config.mode === "blocklist") return true;
  return undefined;
}

export function createChannelEnabledResolver(
  config?: ChannelFilterConfig,
  store?: ChannelEnableStore | null,
): (channelId: string) => boolean {
  const configOverrides = normalizeBooleanOverrides(config?.overrides);
  const legacyList = new Set((config?.list ?? []).map(normalizeDiscordChannelId));
  const legacyMode = config?.mode;
  const defaultEnabled = config?.defaultEnabled ?? resolveLegacyDefault(config) ?? true;

  return (rawChannelId: string): boolean => {
    const channelId = normalizeDiscordChannelId(rawChannelId);

    const stored = store?.getChannelEnabled(channelId);
    if (typeof stored === "boolean") return stored;

    const configOverride = configOverrides.get(channelId);
    if (typeof configOverride === "boolean") return configOverride;

    if (legacyMode === "allowlist") return legacyList.has(channelId);
    if (legacyMode === "blocklist") return !legacyList.has(channelId);

    return defaultEnabled;
  };
}

export function createProfileDbChannelEnableStore(
  db: ProfileDatabase | null,
): ChannelEnableStore | null {
  if (!db) return null;
  return {
    getChannelEnabled(channelId: string): boolean | null {
      return db.getChannelEnabled(channelId);
    },
  };
}
