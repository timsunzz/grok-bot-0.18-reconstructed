import { findBot } from "./roster.js";
import {
  INTENTIONAL_SILENCE_TOKENS,
  type BotDelivery,
  type BotFailureReason,
  type BotRoster,
} from "./types.js";

export const MESSAGE_AGENT_TOOL_NAME = "message_agent";

export const MESSAGE_AGENT_TOOL = {
  name: MESSAGE_AGENT_TOOL_NAME,
  description: "Send an attributed message to another specialist bot's canonical chat. Compose your own words; never forward the user's text verbatim. Delivery is fire-and-forget: you receive queued or settled, and the reply arrives later.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "message"],
    properties: {
      target: { type: "string", description: "Bot slug, friendly name, or id from the live teammate roster." },
      message: { type: "string", description: "The message you composed for that teammate." },
      idempotencyKey: { type: "string", description: "Optional stable key so a retry does not start duplicate work." },
    },
  },
} as const;

export interface MessageAgentArgs {
  readonly target: string;
  readonly message: string;
  readonly idempotencyKey?: string;
}

export function parseMessageAgentArgs(value: unknown): MessageAgentArgs | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.target !== "string" || record.target.trim().length === 0) return null;
  if (typeof record.message !== "string" || record.message.trim().length === 0) return null;
  return {
    target: record.target.trim(),
    message: record.message.trim(),
    ...(typeof record.idempotencyKey === "string" && record.idempotencyKey.trim().length > 0
      ? { idempotencyKey: record.idempotencyKey.trim() }
      : {}),
  };
}

export function attributedBotMessage(sender: { readonly name: string; readonly slug: string }, message: string): string {
  return `Message from 🤖 ${sender.name} (@${sender.slug}):\n${message.trim()}`;
}

export function stripSilenceToken(text: string): { readonly silent: boolean; readonly visible: string } {
  const trimmed = text.trim();
  if ((INTENTIONAL_SILENCE_TOKENS as readonly string[]).includes(trimmed)) return { silent: true, visible: "" };
  return { silent: false, visible: text };
}

export function validateMessageAgent(roster: BotRoster, fromBotId: string, args: MessageAgentArgs): { readonly ok: true; readonly targetId: string } | { readonly ok: false; readonly reason: BotFailureReason; readonly error: string } {
  const sender = roster.bots.find((bot) => bot.id === fromBotId);
  if (sender == null) return { ok: false, reason: "missing_config", error: "The sending bot is not on the roster." };
  const target = findBot(roster, args.target);
  if (target == null) {
    const available = roster.bots.filter((bot) => !bot.hidden && bot.id !== fromBotId).map((bot) => `@${bot.slug}`).join(", ");
    return { ok: false, reason: "missing_config", error: `Unknown teammate "${args.target}".${available.length > 0 ? ` Known handles: ${available}.` : ""}` };
  }
  if (target.id === sender.id) return { ok: false, reason: "missing_config", error: "A bot cannot message itself." };
  return { ok: true, targetId: target.id };
}

export function createQueuedDelivery(args: {
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly message: string;
  readonly idempotencyKey?: string;
  readonly now?: string;
}): BotDelivery {
  const createdAt = args.now ?? new Date().toISOString();
  return {
    id: `dlv-${globalThis.crypto.randomUUID()}`,
    idempotencyKey: args.idempotencyKey ?? `dlv-${globalThis.crypto.randomUUID()}`,
    fromBotId: args.fromBotId,
    toBotId: args.toBotId,
    message: args.message,
    status: "queued",
    createdAt,
  };
}

export function settleDelivery(delivery: BotDelivery, result: { readonly status: "settled" } | { readonly status: "failed"; readonly reason: BotFailureReason; readonly error: string }): BotDelivery {
  return result.status === "settled"
    ? { ...delivery, status: "settled" }
    : { ...delivery, status: "failed", reason: result.reason, error: result.error };
}
