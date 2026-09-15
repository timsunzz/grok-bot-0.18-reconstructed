import { GROUP_MAX_MEMBERS, isSandDefaultAgentName, SAND_AGENT_LIMIT_MESSAGE } from "../agents/agents.js";
import { isSandInferenceProvider, type SandInferenceProvider } from "../inference-router.js";
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  BOT_ID_PATTERN,
  BOT_ROSTER_MAX,
  BOT_SLUG_PATTERN,
  emptyBotRoster,
  isBotProfileRecord,
  type BotGroup,
  type BotProfile,
  type BotRoster,
} from "./types.js";

export class BotRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotRosterError";
  }
}

function newToken(): string {
  return globalThis.crypto.randomUUID();
}

export function slugifyBotName(name: string): string {
  const compact = name
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (BOT_SLUG_PATTERN.test(compact)) return compact;
  const letters = compact.replace(/[^a-z0-9]/g, "");
  if (BOT_SLUG_PATTERN.test(letters)) return letters;
  return `bot-${(letters || "agent").slice(0, 12)}`;
}

export function mentionAliases(bot: Pick<BotProfile, "id" | "slug" | "name">): readonly string[] {
  const aliases = new Set<string>([bot.slug, slugifyBotName(bot.name), bot.name.toLowerCase().replace(/[^a-z0-9]/g, "")]);
  aliases.delete("");
  return [...aliases];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cloneProfile(profile: BotProfile): BotProfile {
  return {
    id: profile.id,
    slug: profile.slug,
    name: profile.name,
    title: profile.title,
    description: profile.description,
    hidden: profile.hidden,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.modelId === undefined ? {} : { modelId: profile.modelId }),
    ...(profile.sectionId === undefined ? {} : { sectionId: profile.sectionId }),
  };
}

export function parseBotRoster(value: unknown): BotRoster {
  const root = asRecord(value);
  if (root == null || root.schemaVersion !== 1) return emptyBotRoster();
  const bots: BotProfile[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  if (Array.isArray(root.bots)) {
    for (const raw of root.bots) {
      if (!isBotProfileRecord(raw) || seenIds.has(raw.id) || seenSlugs.has(raw.slug)) continue;
      seenIds.add(raw.id);
      seenSlugs.add(raw.slug);
      bots.push(cloneProfile(raw));
      if (bots.length >= BOT_ROSTER_MAX) break;
    }
  }
  const groups: BotGroup[] = [];
  const seenGroupIds = new Set<string>();
  if (Array.isArray(root.groups)) {
    for (const raw of root.groups) {
      const record = asRecord(raw);
      if (record == null || typeof record.id !== "string" || !BOT_ID_PATTERN.test(record.id) || seenGroupIds.has(record.id)) continue;
      if (typeof record.name !== "string" || record.name.trim().length === 0) continue;
      if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") continue;
      if (!Array.isArray(record.memberIds)) continue;
      const memberIds = [...new Set(record.memberIds.filter((id): id is string => typeof id === "string" && seenIds.has(id)))];
      if (memberIds.length < BOT_GROUP_MIN_MEMBERS || memberIds.length > BOT_GROUP_MAX_MEMBERS) continue;
      seenGroupIds.add(record.id);
      groups.push({
        id: record.id,
        name: record.name.trim().slice(0, 80),
        memberIds,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
  }
  return { schemaVersion: 1, enabled: root.enabled !== false, bots, groups };
}

export function findBot(roster: BotRoster, handle: string): BotProfile | undefined {
  const trimmed = handle.trim().replace(/^@/, "");
  const needle = trimmed.toLowerCase();
  if (needle.length === 0) return undefined;
  return roster.bots.find((bot) => bot.id === trimmed || bot.id.toLowerCase() === needle || mentionAliases(bot).includes(needle));
}

export function visibleBots(roster: BotRoster): readonly BotProfile[] {
  return roster.bots.filter((bot) => !bot.hidden);
}

export function resolveBotProvider(roster: BotRoster, botId: string, fallback: SandInferenceProvider): SandInferenceProvider {
  const bot = roster.bots.find((item) => item.id === botId);
  return bot?.provider != null && isSandInferenceProvider(bot.provider) ? bot.provider : fallback;
}

export interface UpsertBotInput {
  readonly id?: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly provider?: SandInferenceProvider | null;
  readonly modelId?: string | null;
  readonly hidden?: boolean;
  readonly sectionId?: string | null;
}

export function upsertBot(roster: BotRoster, input: UpsertBotInput, now = new Date().toISOString()): BotRoster {
  const name = input.name.trim();
  if (name.length === 0 || isSandDefaultAgentName(name)) throw new BotRosterError("A bot needs a real name.");
  const id = input.id?.trim() || `bot-${newToken()}`;
  if (!BOT_ID_PATTERN.test(id)) throw new BotRosterError("Invalid bot id.");
  const existing = roster.bots.find((bot) => bot.id === id);
  if (existing == null && roster.bots.length >= BOT_ROSTER_MAX) throw new BotRosterError(SAND_AGENT_LIMIT_MESSAGE);
  const slug = slugifyBotName(name);
  if (roster.bots.some((bot) => bot.id !== id && bot.slug === slug)) throw new BotRosterError(`@${slug} is already taken.`);
  const next: BotProfile = {
    id,
    slug,
    name,
    title: (input.title ?? existing?.title ?? "").trim().slice(0, 80),
    description: (input.description ?? existing?.description ?? "").trim().slice(0, 4_000),
    hidden: input.hidden ?? existing?.hidden ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(input.provider === null ? {} : input.provider !== undefined ? { provider: input.provider } : existing?.provider === undefined ? {} : { provider: existing.provider }),
    ...(input.modelId === null ? {} : input.modelId !== undefined && input.modelId.trim().length > 0 ? { modelId: input.modelId.trim() } : existing?.modelId === undefined ? {} : { modelId: existing.modelId }),
    ...(input.sectionId === null ? {} : input.sectionId !== undefined && input.sectionId.trim().length > 0 ? { sectionId: input.sectionId.trim() } : existing?.sectionId === undefined ? {} : { sectionId: existing.sectionId }),
  };
  const bots = existing == null ? [...roster.bots, next] : roster.bots.map((bot) => bot.id === id ? next : bot);
  return { ...roster, bots };
}

export function hideBot(roster: BotRoster, botId: string, hidden: boolean, now = new Date().toISOString()): BotRoster {
  if (!roster.bots.some((bot) => bot.id === botId)) throw new BotRosterError("Unknown bot.");
  return {
    ...roster,
    bots: roster.bots.map((bot) => bot.id === botId ? { ...bot, hidden, updatedAt: now } : bot),
  };
}

export function deleteBot(roster: BotRoster, botId: string): BotRoster {
  if (!roster.bots.some((bot) => bot.id === botId)) throw new BotRosterError("Unknown bot.");
  return {
    ...roster,
    bots: roster.bots.filter((bot) => bot.id !== botId),
    groups: roster.groups
      .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => id !== botId) }))
      .filter((group) => group.memberIds.length >= BOT_GROUP_MIN_MEMBERS),
  };
}

export function createBotGroup(roster: BotRoster, name: string, memberIds: readonly string[], now = new Date().toISOString()): BotRoster {
  const trimmed = name.trim().slice(0, 80);
  if (trimmed.length === 0) throw new BotRosterError("A group needs a name.");
  const unique = [...new Set(memberIds)];
  if (unique.length < BOT_GROUP_MIN_MEMBERS || unique.length > Math.min(BOT_GROUP_MAX_MEMBERS, GROUP_MAX_MEMBERS)) {
    throw new BotRosterError(`A group needs ${BOT_GROUP_MIN_MEMBERS}–${BOT_GROUP_MAX_MEMBERS} bots.`);
  }
  if (unique.some((id) => !roster.bots.some((bot) => bot.id === id))) throw new BotRosterError("Every group member must be a known bot.");
  if (roster.groups.some((group) => group.name.toLowerCase() === trimmed.toLowerCase())) throw new BotRosterError("That group name is already taken.");
  return {
    ...roster,
    groups: [...roster.groups, { id: `grp-${newToken()}`, name: trimmed, memberIds: unique, createdAt: now, updatedAt: now }],
  };
}
