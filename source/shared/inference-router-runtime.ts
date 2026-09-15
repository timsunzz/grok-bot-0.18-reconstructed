export const DEFAULT_ROUTER_COMPOSE_DELAY_MS = 1_200;
export const DEFAULT_ROUTER_TURN_TIMEOUT_MS = 180_000;
export const DEFAULT_ROUTER_RETRY_DELAY_MS = 750;
export const DEFAULT_ROUTER_LEASE_WAIT_MS = 180_000;
export const DEFAULT_TOOL_LOOP_REPEATS = 3;
export const DEFAULT_TURN_GUARD_MAX_EVENTS = 16;
export const DEFAULT_TURN_GUARD_WINDOW_MS = 60_000;
export const DEFAULT_TURN_GUARD_COOLDOWN_MS = 20_000;

export const PROVIDER_FAILURE_REASONS = [
  "provider_auth_or_access",
  "provider_quota_limit",
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "missing_config",
  "model_unavailable",
  "runtime_offline",
  "delivery_timeout",
  "turn_busy",
  "turn_loop_guard",
  "tool_loop_guard",
  "invalid_request",
  "unknown",
] as const;

export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

const TRANSIENT_FAILURES = new Set<ProviderFailureReason>([
  "provider_rate_limit",
  "provider_server_error",
  "runtime_offline",
  "delivery_timeout",
]);

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw == null || raw.length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

export function transcriptTurnIndex(id: string): number | null {
  const match = /^t(\d+)(?:u|s\d+)$/.exec(id);
  if (match == null) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn >= 0 && turn < 1_000_000_000 ? turn : null;
}

export function highestTranscriptTurn(ids: readonly string[]): number {
  return ids.reduce((highest, id) => {
    const turn = transcriptTurnIndex(id);
    return turn == null ? highest : Math.max(highest, turn);
  }, -1);
}

export function nextTranscriptTurn(...idGroups: readonly (readonly string[])[]): number {
  return Math.max(-1, ...idGroups.map(highestTranscriptTurn)) + 1;
}

export function userEntryId(turn: number): string {
  return `t${turn}u`;
}

export function assistantEntryId(turn: number, index = 0): string {
  return `t${turn}s${index}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyProviderFailure(error: unknown): ProviderFailureReason {
  const text = `${error instanceof Error ? error.name : ""} ${errorText(error)}`.toLowerCase();
  if (/invalid_request|requires an agentid and prompt/.test(text)) return "invalid_request";
  if (/tool loop guard/.test(text)) return "tool_loop_guard";
  if (/turn loop guard|cooldown/.test(text)) return "turn_loop_guard";
  if (/busy|lease/.test(text)) return "turn_busy";
  if (/401|403|unauthor|forbidden|not signed|sign in|login expired|invalid.*(?:key|login|credential)|api key/.test(text)) return "provider_auth_or_access";
  if (/402|quota|billing|insufficient.?credit/.test(text)) return "provider_quota_limit";
  if (/429|rate.?limit|too many requests/.test(text)) return "provider_rate_limit";
  if (/500|502|503|504|server error/.test(text)) return "provider_server_error";
  if (/context[_ ]?(?:length|overflow)|too long|maximum.*token/.test(text)) return "context_overflow";
  if (/not installed|needs openrouter|missing[_ ]config|did not provide/.test(text)) return "missing_config";
  if (/model.*unavail|unknown model/.test(text)) return "model_unavailable";
  if (/econnrefused|enotfound|offline|network/.test(text)) return "runtime_offline";
  if (/abort|timed? ?out|etimedout|econnreset/.test(text)) return "delivery_timeout";
  return "unknown";
}

export function isTransientProviderFailure(reason: ProviderFailureReason): boolean {
  return TRANSIENT_FAILURES.has(reason);
}

export function formatRouterError(error: unknown, reason = classifyProviderFailure(error)): string {
  return `Router error [${reason}]: ${errorText(error)}`;
}

export function stableToolFingerprint(name: string, args: unknown): string {
  try {
    return `${name}:${JSON.stringify(args, (_key, value) => {
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
      }
      return value;
    })}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}

export class ToolLoopGuard {
  private readonly seen: string[] = [];
  constructor(readonly maxRepeats = DEFAULT_TOOL_LOOP_REPEATS) {}
  admit(name: string, args: unknown): { readonly allowed: boolean; readonly fingerprint: string; readonly repeats: number } {
    const fingerprint = stableToolFingerprint(name, args);
    this.seen.push(fingerprint);
    const repeats = this.seen.filter(item => item === fingerprint).length;
    return { allowed: repeats <= this.maxRepeats, fingerprint, repeats };
  }
}

export class ConversationLoopGuard {
  private readonly events = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  constructor(
    readonly maxEvents = DEFAULT_TURN_GUARD_MAX_EVENTS,
    readonly windowMs = DEFAULT_TURN_GUARD_WINDOW_MS,
    readonly cooldownMs = DEFAULT_TURN_GUARD_COOLDOWN_MS,
    readonly now: () => number = Date.now,
  ) {}
  admit(conversation: string): { readonly allowed: boolean; readonly state: "ok" | "tripped" | "cooldown" } {
    const now = this.now();
    const cooling = this.cooldownUntil.get(conversation) ?? 0;
    if (cooling > now) return { allowed: false, state: "cooldown" };
    const cutoff = now - this.windowMs;
    const recent = (this.events.get(conversation) ?? []).filter(stamp => stamp > cutoff);
    if (recent.length >= this.maxEvents) {
      this.cooldownUntil.set(conversation, now + this.cooldownMs);
      this.events.set(conversation, []);
      return { allowed: false, state: "tripped" };
    }
    recent.push(now);
    this.events.set(conversation, recent);
    return { allowed: true, state: "ok" };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withTurnTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
  };
  const timer = setTimeout(() => abort(new Error(`Routed inference timed out after ${timeoutMs}ms.`)), timeoutMs);
  const onParent = () => abort(parent?.reason ?? new Error("Aborted"));
  if (parent?.aborted) onParent();
  else parent?.addEventListener("abort", onParent, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

export function abortControllerFromSignal(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal == null) return controller;
  const forward = () => {
    if (!controller.signal.aborted) controller.abort(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
  };
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  return controller;
}
