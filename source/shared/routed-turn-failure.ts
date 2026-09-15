// Routed turns run against provider clients the desktop app does not own: a local Codex or
// Claude Code login, or OpenRouter over the network. Their failures arrive as free-form
// prose, which leaves both the renderer and the retry logic guessing. Every routed failure
// is therefore classified into this closed vocabulary before it reaches a transcript, so the
// surface can branch on a stable code and only genuinely transient classes are retried.

import { parseRetryAfterHeaderMs } from "./retry-after.js";

export const ROUTED_TURN_FAILURE_REASONS = [
  "missing_credential",
  "provider_not_installed",
  "provider_auth",
  "provider_quota",
  "provider_rate_limit",
  "provider_server_error",
  "provider_unavailable",
  "context_overflow",
  "tool_step_limit",
  "malformed_response",
  "invalid_request",
  "cancelled",
  "unknown",
] as const;

export type RoutedTurnFailureReason = (typeof ROUTED_TURN_FAILURE_REASONS)[number];

// The name a routed turn's own deadline carries. `provider-session.ts` raises it; the classifier
// below reads it.
export const ROUTED_TURN_TIMEOUT_ERROR_NAME = "RoutedTurnTimeoutError";

// A retried turn resumes the same conversation; it never mints a new one. Classes that a
// retry cannot fix are refused immediately rather than burning a second provider request.
export type RoutedTurnRetryPolicy = "none" | "resume";

// What the attempt already did before it failed. A routed turn can execute plugin tools for
// several steps before the provider stream dies, and nothing rolls those effects back, so
// replaying the prompt would apply them a second time. An attempt that may have changed
// something outside this process is therefore never retried automatically, however transient
// the failure looked: an unknown outcome is not permission to re-execute.
export type RoutedTurnProgress = { readonly appliedWriteEffect: boolean };

const RETRYABLE: readonly RoutedTurnFailureReason[] = [
  "provider_rate_limit",
  "provider_server_error",
  "provider_unavailable",
  "malformed_response",
];

export function routedTurnRetryPolicy(reason: RoutedTurnFailureReason, progress?: RoutedTurnProgress): RoutedTurnRetryPolicy {
  if (progress?.appliedWriteEffect === true) return "none";
  return RETRYABLE.includes(reason) ? "resume" : "none";
}

// A provider that refused with `Retry-After` has said when it will accept work again. Retrying
// before then just re-trips the same limit, so the pacing is honoured rather than guessed. When
// the provider asks for longer than a foreground turn can hide, the turn fails with its reason
// instead of stalling behind a silent sleep the person cannot see or cancel.
export const MAX_ROUTED_RETRY_DELAY_MS = 30_000;
const BASE_ROUTED_RETRY_DELAY_MS = 750;

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers == null) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

function retryAfterMsOf(error: unknown): number | undefined {
  const holder = typeof error === "object" && error != null ? error as Record<string, unknown> : null;
  if (holder == null) return undefined;
  const annotated = holder.retryAfterMs;
  if (typeof annotated === "number" && Number.isFinite(annotated) && annotated >= 0) return annotated;
  // The AI SDK carries the refusal's headers on the error it throws; a direct fetch path
  // annotates `retryAfterMs` itself.
  const raw = headerValue(holder.responseHeaders, "retry-after") ?? headerValue(holder.headers, "retry-after");
  return raw == null ? retryAfterMsOf(holder.cause) : parseRetryAfterHeaderMs(raw);
}

function jittered(delayMs: number, random: () => number): number {
  return Math.min(MAX_ROUTED_RETRY_DELAY_MS, Math.round(delayMs + random() * delayMs / 2));
}

// `null` means "do not retry": the provider asked for a longer pause than a turn can absorb.
export function routedTurnRetryDelayMs(error: unknown, random: () => number = Math.random): number | null {
  const paced = retryAfterMsOf(error);
  // `Retry-After: 0` carries no pacing at all, and treating it as "now" would hot-loop the
  // provider that just refused us.
  if (paced == null || paced <= 0) return jittered(BASE_ROUTED_RETRY_DELAY_MS, random);
  return paced > MAX_ROUTED_RETRY_DELAY_MS ? null : jittered(paced, random);
}

export function isRoutedTurnFailureReason(value: unknown): value is RoutedTurnFailureReason {
  return typeof value === "string" && (ROUTED_TURN_FAILURE_REASONS as readonly string[]).includes(value);
}

export function routedTurnFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return String(error);
}

function scrapedHttpStatus(text: string): number | null {
  const match = /\b(?:failed|error|status)\b[^0-9]{0,24}\b([1-5][0-9]{2})\b/.exec(text) ?? /\bHTTP\s+([1-5][0-9]{2})\b/.exec(text);
  const status = match?.[1] == null ? Number.NaN : Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

// Reading the status the provider client recorded beats scraping it out of a sentence, which
// only works for as long as nobody rewords the sentence.
function annotatedHttpStatus(error: unknown, depth = 0): number | null {
  const holder = typeof error === "object" && error != null ? error as Record<string, unknown> : null;
  if (holder == null || depth > 2) return null;
  for (const key of ["status", "statusCode"]) {
    const raw = holder[key];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
  }
  return annotatedHttpStatus(holder.cause, depth + 1);
}

export function classifyRoutedTurnFailure(error: unknown): RoutedTurnFailureReason {
  const name = error instanceof Error ? error.name : "";
  const text = routedTurnFailureMessage(error).toLowerCase();

  // A turn the app gave up on is not a turn the person cancelled, and the difference decides
  // whether it is retried. This is why the deadline does not raise `AbortError` or
  // `TimeoutError`: both of those arrive when someone cancels, and land below.
  if (name === ROUTED_TURN_TIMEOUT_ERROR_NAME) return "provider_unavailable";
  if (name === "AbortError" || name === "TimeoutError" || /\baborted\b|\bcancell?ed\b/.test(text)) return "cancelled";

  if (/needs openrouter_api_key|add it in settings|missing api key|no api key/.test(text)) return "missing_credential";
  if (/is not installed|could not be found on this machine|command not found|enoent/.test(text)) return "provider_not_installed";
  if (/not signed in|login expired|run `codex login`|unauthorized|invalid api key|invalid_api_key|authentication|credentials must be/.test(text)) return "provider_auth";
  if (/quota|insufficient_quota|billing|payment required|out of credit|credit balance/.test(text)) return "provider_quota";
  if (/rate limit|rate_limit|too many requests|overloaded/.test(text)) return "provider_rate_limit";
  if (/context (?:length|window)|too many tokens|maximum context|context_length_exceeded|prompt is too long/.test(text)) return "context_overflow";
  if (/step tool limit|exceeded .* steps?/.test(text)) return "tool_step_limit";
  if (/malformed sse|incomplete sse|without response\.completed|before reporting a result|did not include a stream|ended without a result|invalid json/.test(text)) return "malformed_response";
  if (/fetch failed|network|socket hang up|econnrefused|econnreset|enotfound|etimedout|epipe|timed out|unreachable/.test(text)) return "provider_unavailable";

  const status = annotatedHttpStatus(error) ?? scrapedHttpStatus(text);
  if (status != null) {
    if (status === 401 || status === 403) return "provider_auth";
    if (status === 402) return "provider_quota";
    if (status === 429) return "provider_rate_limit";
    if (status >= 500) return "provider_server_error";
    if (status >= 400) return "invalid_request";
  }

  if (/requires an agentid|requires a prompt|did not provide an executor|unknown grok bot tool/.test(text)) return "invalid_request";
  return "unknown";
}

// The reason code leads so a surface can parse it without reading the human sentence, which
// stays verbatim behind it for the person who has to act on the failure. A turn that already
// applied something says so, because the useful next step is checking what landed rather than
// sending the same request again.
export function formatRoutedTurnFailure(error: unknown, reason = classifyRoutedTurnFailure(error), progress?: RoutedTurnProgress): string {
  const applied = progress?.appliedWriteEffect === true
    ? " Plugin actions from this turn already ran, so it was not retried automatically: check what took effect before sending it again."
    : "";
  return `[reason: ${reason}] Router error: ${routedTurnFailureMessage(error)}${applied}`;
}
