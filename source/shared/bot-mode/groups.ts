import {
  BOT_GROUP_MAX_MESSAGES_PER_SEND,
  BOT_GROUP_MAX_ROUNDS,
  type BotGroup,
  type BotRoster,
} from "./types.js";

export interface GroupTurnPlan {
  readonly groupId: string;
  readonly round: number;
  readonly speakerIds: readonly string[];
  readonly settled: boolean;
  readonly needsUser: boolean;
}

export function parseUserMentions(text: string): boolean {
  return /(^|[\s(])@user\b/i.test(text);
}

export function planGroupRound(args: {
  readonly roster: BotRoster;
  readonly group: BotGroup;
  readonly mentionedBotIds?: readonly string[];
  readonly previousSilentIds?: readonly string[];
  readonly round: number;
  readonly messageCount?: number;
}): GroupTurnPlan {
  const members = args.group.memberIds.filter((id) => args.roster.bots.some((bot) => bot.id === id));
  const mentioned = (args.mentionedBotIds ?? []).filter((id) => members.includes(id));
  const tooManyMessages = (args.messageCount ?? 0) > BOT_GROUP_MAX_MESSAGES_PER_SEND;
  const pastRounds = args.round >= BOT_GROUP_MAX_ROUNDS;
  if (members.length === 0 || tooManyMessages || pastRounds) {
    return { groupId: args.group.id, round: args.round, speakerIds: [], settled: true, needsUser: false };
  }
  const silent = new Set(args.previousSilentIds ?? []);
  const candidates = (mentioned.length > 0 ? mentioned : members).filter((id) => !silent.has(id));
  return {
    groupId: args.group.id,
    round: args.round,
    speakerIds: candidates,
    settled: candidates.length === 0,
    needsUser: false,
  };
}

export function nextGroupRound(plan: GroupTurnPlan, replies: readonly { readonly botId: string; readonly silent: boolean; readonly needsUser?: boolean; readonly text?: string }[]): GroupTurnPlan {
  const silentIds = replies.filter((reply) => reply.silent).map((reply) => reply.botId);
  const everyoneSilent = plan.speakerIds.length > 0 && plan.speakerIds.every((id) => silentIds.includes(id));
  const needsUser = replies.some((reply) => reply.needsUser === true || (reply.text != null && parseUserMentions(reply.text)));
  if (everyoneSilent || needsUser || plan.round + 1 >= BOT_GROUP_MAX_ROUNDS) {
    return { groupId: plan.groupId, round: plan.round + 1, speakerIds: [], settled: true, needsUser };
  }
  return {
    groupId: plan.groupId,
    round: plan.round + 1,
    speakerIds: plan.speakerIds.filter((id) => !silentIds.includes(id)),
    settled: false,
    needsUser,
  };
}

export function clampGroupMessages(messages: readonly string[]): readonly string[] {
  return messages.slice(0, BOT_GROUP_MAX_MESSAGES_PER_SEND);
}
