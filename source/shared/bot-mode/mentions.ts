import { findBot, mentionAliases } from "./roster.js";
import type { BotProfile, BotRoster } from "./types.js";

const MENTION_PATTERN = /(^|[\s(])@([A-Za-z][\w-]{0,63})\b/g;

function isEmailMention(text: string, match: RegExpMatchArray): boolean {
  const end = (match.index ?? 0) + match[0].length;
  return /^\.[A-Za-z]{2,}/.test(text.slice(end));
}

export interface ResolvedMention {
  readonly raw: string;
  readonly handle: string;
  readonly bot: BotProfile;
  readonly index: number;
}

export function extractMentionHandles(text: string): readonly string[] {
  const handles: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[2];
    if (handle == null || isEmailMention(text, match)) continue;
    handles.push(handle.toLowerCase());
  }
  return [...new Set(handles)];
}

export function resolveMentions(text: string, roster: BotRoster): readonly ResolvedMention[] {
  const resolved: ResolvedMention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[2];
    if (handle == null || isEmailMention(text, match)) continue;
    const start = match.index ?? 0;
    const bot = findBot(roster, handle);
    if (bot == null || seen.has(bot.id)) continue;
    seen.add(bot.id);
    resolved.push({ raw: `@${handle}`, handle: handle.toLowerCase(), bot, index: start + (match[1]?.length ?? 0) });
  }
  return resolved;
}

export function unknownMentions(text: string, roster: BotRoster): readonly string[] {
  return extractMentionHandles(text).filter((handle) => findBot(roster, handle) == null);
}

export function describeMentionResolution(mentions: readonly ResolvedMention[]): string {
  if (mentions.length === 0) return "";
  return mentions
    .map((mention) => `@${mention.bot.slug} is ${mention.bot.name}${mention.bot.title.length > 0 ? ` (${mention.bot.title})` : ""}`)
    .join("\n");
}

export function botAnswersTo(bot: BotProfile, handle: string): boolean {
  return mentionAliases(bot).includes(handle.trim().replace(/^@/, "").toLowerCase());
}
