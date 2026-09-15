export const BOT_SESSION_KEY_PREFIX = "agent";
export const DEFAULT_BOT_PENDING_QUEUE_CAP = 32;
export const DEFAULT_ROUTED_TURN_TIMEOUT_MS = 180_000;
export const DEFAULT_ROUTED_RETRY_ATTEMPTS = 3;
export const DEFAULT_ROUTED_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_ROUTED_RETRY_MAX_DELAY_MS = 4_000;
export const BOT_BUSY_COMMANDS = ["stop", "status", "queue", "new", "approve", "deny"] as const;

export type BotChatType = "private" | "group" | "channel" | "thread";
export type BotBusyCommand = (typeof BOT_BUSY_COMMANDS)[number];
export type RoutedErrorKind = "auth" | "timeout" | "rate_limit" | "transient" | "cancelled" | "validation" | "internal";

export interface BotSessionAddress {
  readonly agentId: string;
  readonly platform: string;
  readonly chatType: BotChatType;
  readonly chatId: string;
  readonly threadId?: string;
}

export interface BotAuthPolicy {
  readonly allowAll?: boolean;
  readonly platformAllowAll?: boolean;
  readonly allowedUsers?: readonly string[];
}

export interface BotAuthDecision {
  readonly allowed: boolean;
  readonly reason?: "empty-sender" | "not-allowlisted";
}

export interface ClassifiedRoutedError {
  readonly kind: RoutedErrorKind;
  readonly retryable: boolean;
  readonly message: string;
}

function sanitizeSessionPart(value: string): string {
  return value.trim().replace(/[:\s]+/g, "_");
}

export function normalizeBotChatType(value: unknown): BotChatType {
  return value === "group" || value === "channel" || value === "thread" ? value : "private";
}

export function buildBotSessionKey(input: {
  readonly agentId: string;
  readonly platform: string;
  readonly chatType?: unknown;
  readonly chatId: string;
  readonly threadId?: string;
}): string {
  const platform = sanitizeSessionPart(input.platform);
  const chatId = sanitizeSessionPart(input.chatId);
  if (platform.length === 0 || chatId.length === 0) throw new Error("Bot session keys require platform and chat id");
  const agentId = sanitizeSessionPart(input.agentId) || "main";
  const chatType = normalizeBotChatType(input.chatType);
  const threadId = input.threadId == null ? "" : sanitizeSessionPart(input.threadId);
  return threadId.length === 0
    ? `${BOT_SESSION_KEY_PREFIX}:${agentId}:${platform}:${chatType}:${chatId}`
    : `${BOT_SESSION_KEY_PREFIX}:${agentId}:${platform}:${chatType}:${chatId}:${threadId}`;
}

export function parseBotSessionKey(key: string): BotSessionAddress | null {
  const parts = key.split(":");
  if (parts.length < 5 || parts[0] !== BOT_SESSION_KEY_PREFIX) return null;
  const agentId = parts[1] ?? "";
  const platform = parts[2] ?? "";
  const chatType = normalizeBotChatType(parts[3]);
  const chatId = parts[4] ?? "";
  const threadId = parts.slice(5).join(":");
  if (agentId.length === 0 || platform.length === 0 || chatId.length === 0) return null;
  return threadId.length === 0
    ? { agentId, platform, chatType, chatId }
    : { agentId, platform, chatType, chatId, threadId };
}

export function authorizeBotSender(senderId: string, policy?: BotAuthPolicy): BotAuthDecision {
  const sender = senderId.trim();
  if (sender.length === 0) return { allowed: false, reason: "empty-sender" };
  if (policy?.platformAllowAll === true || policy?.allowAll === true) return { allowed: true };
  const allowlist = (policy?.allowedUsers ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (allowlist.length === 0) return { allowed: true };
  return allowlist.includes(sender) || allowlist.includes("*")
    ? { allowed: true }
    : { allowed: false, reason: "not-allowlisted" };
}

export function admitBotInboundMessage(input: {
  readonly chatType?: unknown;
  readonly mentionedBot?: boolean;
  readonly mentionedOthers?: boolean;
  readonly requireMention?: boolean;
  readonly ignoreNoMention?: boolean;
}): { readonly admit: true } | { readonly admit: false; readonly reason: "require-mention" | "directed-elsewhere" } {
  const chatType = normalizeBotChatType(input.chatType);
  const isGroup = chatType === "group" || chatType === "channel" || chatType === "thread";
  if (!isGroup) return { admit: true };
  if (input.requireMention === true && input.mentionedBot !== true) return { admit: false, reason: "require-mention" };
  if (input.ignoreNoMention !== false && input.mentionedOthers === true && input.mentionedBot !== true) {
    return { admit: false, reason: "directed-elsewhere" };
  }
  return { admit: true };
}

export function parseBotBusyCommand(text: string): BotBusyCommand | null {
  const match = /^\/(stop|status|queue|new|approve|deny)(?:\s|$)/i.exec(text.trim());
  return match == null ? null : match[1]!.toLowerCase() as BotBusyCommand;
}

export function createBotSessionGuard<T>(options?: { readonly queueCap?: number }) {
  const running = new Set<string>();
  const pending = new Map<string, T[]>();
  const queueCap = options?.queueCap ?? DEFAULT_BOT_PENDING_QUEUE_CAP;
  return {
    isRunning(sessionKey: string): boolean { return running.has(sessionKey); },
    begin(sessionKey: string): void { running.add(sessionKey); },
    end(sessionKey: string): void { running.delete(sessionKey); },
    admit(sessionKey: string, payload: T, text = ""):
      | { readonly action: "run" }
      | { readonly action: "queue"; readonly queued: number }
      | { readonly action: "busy-command"; readonly command: BotBusyCommand }
      | { readonly action: "drop"; readonly reason: "queue-cap" } {
      const command = parseBotBusyCommand(text);
      if (command != null) return { action: "busy-command", command };
      if (!running.has(sessionKey)) return { action: "run" };
      const queue = pending.get(sessionKey) ?? [];
      if (queue.length >= queueCap) return { action: "drop", reason: "queue-cap" };
      queue.push(payload);
      pending.set(sessionKey, queue);
      return { action: "queue", queued: queue.length };
    },
    drain(sessionKey: string): T[] {
      const items = pending.get(sessionKey) ?? [];
      pending.delete(sessionKey);
      return items;
    },
  };
}

export function createBotRateLimiter(options?: {
  readonly maxTokens?: number;
  readonly refillEveryMs?: number;
  readonly now?: () => number;
}) {
  const maxTokens = options?.maxTokens ?? 8;
  const refillEveryMs = options?.refillEveryMs ?? 10_000;
  const now = options?.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  return {
    take(key: string): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
      const at = now();
      const current = buckets.get(key) ?? { tokens: maxTokens, lastRefillMs: at };
      const elapsed = Math.max(0, at - current.lastRefillMs);
      const refilled = refillEveryMs <= 0 ? 0 : Math.floor(elapsed / refillEveryMs);
      const tokens = Math.min(maxTokens, current.tokens + refilled);
      const lastRefillMs = current.lastRefillMs + refilled * refillEveryMs;
      if (tokens <= 0) {
        buckets.set(key, { tokens: 0, lastRefillMs });
        return { allowed: false, retryAfterMs: Math.max(0, refillEveryMs - (at - lastRefillMs)) };
      }
      buckets.set(key, { tokens: tokens - 1, lastRefillMs });
      return { allowed: true };
    },
  };
}

export function createBotEventDedupe(options?: { readonly ttlMs?: number; readonly now?: () => number }) {
  const ttlMs = options?.ttlMs ?? 10 * 60_000;
  const now = options?.now ?? Date.now;
  const seen = new Map<string, number>();
  return {
    seen(eventId: string): boolean {
      const id = eventId.trim();
      if (id.length === 0) return false;
      const at = now();
      for (const [key, stamped] of seen) if (at - stamped > ttlMs) seen.delete(key);
      if (seen.has(id)) return true;
      seen.set(id, at);
      return false;
    },
  };
}

export class RoutedTurnTimeoutError extends Error {
  readonly kind = "timeout";
  constructor(timeoutMs: number) {
    super(`Routed provider timed out after ${Math.round(timeoutMs / 1_000)}s.`);
    this.name = "RoutedTurnTimeoutError";
  }
}

export class RoutedTurnCancelledError extends Error {
  readonly kind = "cancelled";
  constructor() {
    super("Routed provider turn was cancelled.");
    this.name = "RoutedTurnCancelledError";
  }
}

export function classifyRoutedProviderError(error: unknown): ClassifiedRoutedError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const lower = message.toLowerCase();
  if (error instanceof RoutedTurnCancelledError || name === "RoutedTurnCancelledError") {
    return { kind: "cancelled", retryable: false, message };
  }
  if (error instanceof RoutedTurnTimeoutError || name === "RoutedTurnTimeoutError" || /\btimeout\b|timed out|deadline/.test(lower)) {
    return { kind: "timeout", retryable: true, message };
  }
  if (name === "AbortError" || lower === "aborted" || /cancell?ed/.test(lower)) {
    return { kind: "cancelled", retryable: false, message };
  }
  if (/401|unauthor|not signed in|api[_ ]?key|credentials|login expired|access token/.test(lower)) {
    return { kind: "auth", retryable: false, message };
  }
  if (/429|rate limit|too many requests|resource.?exhausted/.test(lower)) {
    return { kind: "rate_limit", retryable: true, message };
  }
  if (/requires an agentid|agentid and prompt/.test(lower)) {
    return { kind: "validation", retryable: false, message };
  }
  if (/econnreset|etimedout|econnrefused|enotfound|eai_again|socket hang up|network error|unavailable|premature close|connection reset/.test(lower)) {
    return { kind: "transient", retryable: true, message };
  }
  return { kind: "internal", retryable: false, message };
}

export function formatRoutedProviderError(provider: string, classified: ClassifiedRoutedError): string {
  return `Router error (${provider}/${classified.kind}): ${classified.message}`;
}

export function resolveRoutedTurnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.SAND_ROUTED_TURN_TIMEOUT_MS?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_ROUTED_TURN_TIMEOUT_MS;
}

export async function withRoutedTurnDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ROUTED_TURN_TIMEOUT_MS;
  if (options?.signal?.aborted) throw new RoutedTurnCancelledError();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RoutedTurnTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      run(controller.signal).catch((error) => {
        if (timedOut) return new Promise<never>(() => {});
        if (options?.signal?.aborted) throw new RoutedTurnCancelledError();
        throw error;
      }),
      timeout,
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function runWithRoutedRetry<T>(
  run: () => Promise<T>,
  options?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly isRetryable?: (error: unknown) => boolean;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_ROUTED_RETRY_ATTEMPTS);
  const isRetryable = options?.isRetryable ?? ((error: unknown) => classifyRoutedProviderError(error).retryable);
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_ROUTED_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_ROUTED_RETRY_MAX_DELAY_MS;
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await run(); } catch (error) {
      last = error;
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw last;
}
