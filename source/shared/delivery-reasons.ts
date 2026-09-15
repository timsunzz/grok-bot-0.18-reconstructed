export const DELIVERY_REASONS = [
  "provider_auth_or_access",
  "provider_quota_limit",
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "missing_config",
  "model_unavailable",
  "runtime_offline",
  "queued_expired",
  "delivery_timeout",
  "target_busy",
  "unknown",
] as const;

export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

export const TRANSIENT_DELIVERY_REASONS = new Set<DeliveryReason>([
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "runtime_offline",
  "delivery_timeout",
]);

export function isDeliveryReason(value: unknown): value is DeliveryReason {
  return typeof value === "string" && (DELIVERY_REASONS as readonly string[]).includes(value);
}

export function isTransientDeliveryReason(reason: DeliveryReason): boolean {
  return TRANSIENT_DELIVERY_REASONS.has(reason);
}

export function shouldAutoRetryDelivery(reason: DeliveryReason, priorAttempts = 0): boolean {
  return priorAttempts === 0 && isTransientDeliveryReason(reason);
}

export function formatDeliveryNotice(reason: DeliveryReason, text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? `[reason:${reason}]` : `[reason:${reason}] ${trimmed}`;
}

export function parseDeliveryNotice(text: string): { readonly reason: DeliveryReason; readonly text: string } {
  const match = /^\[reason:([a-z0-9_]+)\]\s*([\s\S]*)$/.exec(text.trim());
  if (match == null || !isDeliveryReason(match[1])) return { reason: "unknown", text: text.trim() };
  return { reason: match[1], text: match[2]!.trim() };
}

export function classifyChannelDeliveryFailure(addressToken: string, rawMessage: string): DeliveryReason {
  const trimmed = rawMessage.trim();
  if (addressToken.trim().length === 0 || /not a valid channel address/i.test(trimmed)) return "missing_config";
  if (trimmed === "No channel delivery mechanism is registered.") return "missing_config";
  if (/no live .* connection/i.test(trimmed)) return "missing_config";
  return classifyErrorText(trimmed);
}

export function classifyAgentSendFailure(
  kind: "empty" | "self" | "gone" | "remote-room" | "not-found" | "busy",
): DeliveryReason {
  switch (kind) {
    case "empty":
    case "self":
    case "gone":
    case "remote-room":
    case "not-found":
      return "missing_config";
    case "busy":
      return "target_busy";
  }
}

export function classifyErrorForDelivery(error: unknown): DeliveryReason {
  const name = error instanceof Error ? error.name : "";
  if (name === "SandConversationTooLargeError" || name === "PromptAcceptanceUnknownDurabilityError") {
    return name === "SandConversationTooLargeError" ? "context_overflow" : "unknown";
  }
  if (name === "SandChannelDeliveryUnregisteredError") return "missing_config";
  if (name === "AgentGoneError") return "missing_config";
  return classifyErrorText(error instanceof Error ? error.message : String(error));
}

function classifyErrorText(text: string): DeliveryReason {
  if (/context (?:window )?overflow|conversation(?:'s stored state)? is .* over the .* limit|too large/i.test(text)) {
    return "context_overflow";
  }
  if (/quota|billing|insufficient[_ ](?:quota|credit)/i.test(text)) return "provider_quota_limit";
  if (/401|403|unauth|forbidden|permission denied|not signed in/i.test(text)) return "provider_auth_or_access";
  if (/429|rate limit|overloaded|capacity deferred|resource.?exhausted/i.test(text)) return "provider_rate_limit";
  if (/5\d\d|server error|service unavailable|bad gateway/i.test(text)) return "provider_server_error";
  if (/timed? ?out|etimedout|aborterror|delivery timeout/i.test(text)) return "delivery_timeout";
  if (/econnrefused|enotfound|offline|ehostunreach/i.test(text)) return "runtime_offline";
  if (/not installed|api[_ ]?key|missing.?config|isn't connected|needs OPENROUTER/i.test(text)) return "missing_config";
  if (/model .* unavailable|unknown model/i.test(text)) return "model_unavailable";
  return "unknown";
}
