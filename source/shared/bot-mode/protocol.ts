import { MESSAGE_AGENT_TOOL_NAME } from "./messaging.js";
import { mentionAliases } from "./roster.js";
import { visibleBots } from "./roster.js";
import type { BotProfile, BotRoster } from "./types.js";

export function teammateRosterPrompt(roster: BotRoster, selfId: string): string {
  const teammates = visibleBots(roster).filter((bot) => bot.id !== selfId);
  if (teammates.length === 0) return "";
  const lines = teammates.map((bot) => {
    const role = bot.title.trim().length > 0 ? bot.title.trim() : "specialist";
    const summary = bot.description.trim().length > 0 ? bot.description.trim() : "No standing instructions.";
    return `- @${bot.slug} (${bot.name}) — ${role}. Also answers to ${mentionAliases(bot).map((alias) => `@${alias}`).join(", ")}. ${summary}`;
  });
  return [
    "Teammates on this machine:",
    ...lines,
    "",
    "Message a teammate with the message_agent tool. Compose your own words; never forward the user's text verbatim.",
    "If you have nothing to add, reply with [SILENT] and nothing else.",
    "Escalate a real judgment call to the human with @user.",
  ].join("\n");
}

export function botSoulPrompt(bot: BotProfile): string {
  const parts = [`You are ${bot.name}, a named Grok Bot specialist.`];
  if (bot.title.trim().length > 0) parts.push(`Title: ${bot.title.trim()}.`);
  if (bot.description.trim().length > 0) parts.push(bot.description.trim());
  parts.push(`Your mention handle is @${bot.slug}.`);
  return parts.join(" ");
}

export function botModeSystemPrompt(args: {
  readonly roster: BotRoster;
  readonly bot: BotProfile;
  readonly mentioned?: readonly BotProfile[];
}): string {
  if (!args.roster.enabled) return botSoulPrompt(args.bot);
  const mentions = (args.mentioned ?? []).filter((bot) => bot.id !== args.bot.id);
  const mentionBlock = mentions.length === 0
    ? ""
    : `\nThe user addressed: ${mentions.map((bot) => `@${bot.slug} (${bot.name})`).join(", ")}. If they need another specialist, call ${MESSAGE_AGENT_TOOL_NAME}.`;
  return [botSoulPrompt(args.bot), teammateRosterPrompt(args.roster, args.bot.id), mentionBlock].filter((part) => part.length > 0).join("\n\n");
}
