import type { AgentDesktopBridge } from "../../../contracts/desktop-bridge";
import type { RouterProviderId } from "./router";

export interface SettingsBot {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly provider?: RouterProviderId;
}

export interface SettingsBotRoster {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly bots: readonly SettingsBot[];
}

export const EMPTY_BOT_ROSTER: SettingsBotRoster = { schemaVersion: 1, enabled: true, bots: [] };

export function parseSettingsBotRoster(value: unknown): SettingsBotRoster {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return EMPTY_BOT_ROSTER;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.bots)) return EMPTY_BOT_ROSTER;
  const bots: SettingsBot[] = [];
  for (const raw of record.bots) {
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) continue;
    const bot = raw as Record<string, unknown>;
    if (typeof bot.id !== "string" || typeof bot.slug !== "string" || typeof bot.name !== "string") continue;
    bots.push({
      id: bot.id,
      slug: bot.slug,
      name: bot.name,
      title: typeof bot.title === "string" ? bot.title : "",
      description: typeof bot.description === "string" ? bot.description : "",
      hidden: bot.hidden === true,
      ...(typeof bot.provider === "string" ? { provider: bot.provider as RouterProviderId } : {})
    });
  }
  return { schemaVersion: 1, enabled: record.enabled !== false, bots };
}

export type BotRosterBridge = Pick<AgentDesktopBridge, "getBotRoster" | "upsertBot" | "hideBot" | "deleteBot">;

export async function loadBotRoster(bridge: BotRosterBridge): Promise<SettingsBotRoster> {
  if (bridge.getBotRoster == null) return EMPTY_BOT_ROSTER;
  return parseSettingsBotRoster(await bridge.getBotRoster());
}

export async function saveBot(bridge: BotRosterBridge, bot: { name: string; title?: string; description?: string; provider?: RouterProviderId | null; id?: string }): Promise<SettingsBotRoster> {
  if (bridge.upsertBot == null) throw new Error("Bot roster is unavailable.");
  return parseSettingsBotRoster(await bridge.upsertBot(bot));
}
