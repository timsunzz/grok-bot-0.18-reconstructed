import {
  TRANSIENT_BOT_FAILURES,
  isBotFailureReason,
  type BotFailureReason,
} from "./types.js";

const REASON_PATTERNS: readonly { readonly reason: BotFailureReason; readonly pattern: RegExp }[] = [
  { reason: "provider_auth_or_access", pattern: /\b(401|403|unauthoriz|forbidden|not signed in|sign in|login expired|invalid.*(?:key|token|login)|api key)\b/i },
  { reason: "provider_quota_limit", pattern: /\b(quota|billing|insufficient[_\s-]?quota|payment required|402)\b/i },
  { reason: "provider_rate_limit", pattern: /\b(429|rate[_ ]?limit|too many requests|retry-after)\b/i },
  { reason: "provider_server_error", pattern: /\b(500|502|503|504|bad gateway|service unavailable|internal server error)\b/i },
  { reason: "context_overflow", pattern: /\b(context[_\s-]?(?:length|window|overflow)|maximum context|too many tokens|prompt is too long)\b/i },
  { reason: "missing_config", pattern: /\b(needs [A-Z0-9_]+|not installed|missing[_\s-]?config|add it in settings)\b/i },
  { reason: "model_unavailable", pattern: /\b(model[_\s-]?(?:unavailable|not found|does not exist)|unknown model)\b/i },
  { reason: "runtime_offline", pattern: /\b(econnrefused|enotfound|offline|network|fetch failed|socket hang up)\b/i },
  { reason: "queued_expired", pattern: /\b(queued[_ ]expired|queue expired)\b/i },
  { reason: "delivery_timeout", pattern: /\b(etimedout|timeout|timed out)\b/i },
  { reason: "target_busy", pattern: /\b(target_busy|session_not_owned|already running)\b/i },
];

export function classifyBotFailure(error: unknown): BotFailureReason {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const tagged = /\[reason:([a-z_]+)\]/.exec(text);
  if (tagged != null && isBotFailureReason(tagged[1])) return tagged[1];
  for (const entry of REASON_PATTERNS) {
    if (entry.pattern.test(text)) return entry.reason;
  }
  return "unknown";
}

export function isTransientBotFailure(reason: BotFailureReason): boolean {
  return TRANSIENT_BOT_FAILURES.has(reason);
}

export function formatBotFailure(reason: BotFailureReason, message: string): string {
  const trimmed = message.trim();
  return `[reason:${reason}] ${trimmed.length > 0 ? trimmed : reason}`;
}

export function parseBotFailureTag(text: string): { readonly reason: BotFailureReason; readonly message: string } | null {
  const match = /^\[reason:([a-z_]+)\]\s*(.*)$/.exec(text.trim());
  if (match == null || !isBotFailureReason(match[1])) return null;
  return { reason: match[1], message: match[2] ?? "" };
}

export class BotFailure extends Error {
  readonly reason: BotFailureReason;
  constructor(reason: BotFailureReason, message: string) {
    super(formatBotFailure(reason, message));
    this.name = "BotFailure";
    this.reason = reason;
  }
}

export function asBotFailure(error: unknown): BotFailure {
  if (error instanceof BotFailure) return error;
  const reason = classifyBotFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  return new BotFailure(reason, message);
}
