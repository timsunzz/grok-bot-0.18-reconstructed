// Routed turns run against provider clients the desktop app does not own: a local Codex or
// Claude Code login, or OpenRouter over the network. Their failures arrive as free-form
// prose, which leaves both the renderer and the retry logic guessing. Every routed failure
// is therefore classified into this closed vocabulary before it reaches a transcript, so the
// surface can branch on a stable code and only genuinely transient classes are retried.

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

// A retried turn resumes the same conversation; it never mints a new one. Classes that a
// retry cannot fix are refused immediately rather than burning a second provider request.
export type RoutedTurnRetryPolicy = "none" | "resume";

const RETRYABLE: readonly RoutedTurnFailureReason[] = [
  "provider_rate_limit",
  "provider_server_error",
  "provider_unavailable",
  "malformed_response",
];

export function routedTurnRetryPolicy(reason: RoutedTurnFailureReason): RoutedTurnRetryPolicy {
  return RETRYABLE.includes(reason) ? "resume" : "none";
}

export function isRoutedTurnFailureReason(value: unknown): value is RoutedTurnFailureReason {
  return typeof value === "string" && (ROUTED_TURN_FAILURE_REASONS as readonly string[]).includes(value);
}

export function routedTurnFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return String(error);
}

function httpStatus(text: string): number | null {
  const match = /\b(?:failed|error|status)\b[^0-9]{0,24}\b([1-5][0-9]{2})\b/.exec(text) ?? /\bHTTP\s+([1-5][0-9]{2})\b/.exec(text);
  const status = match?.[1] == null ? Number.NaN : Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

export function classifyRoutedTurnFailure(error: unknown): RoutedTurnFailureReason {
  const name = error instanceof Error ? error.name : "";
  const text = routedTurnFailureMessage(error).toLowerCase();

  if (name === "AbortError" || name === "TimeoutError" || /\baborted\b|\bcancell?ed\b/.test(text)) return "cancelled";

  if (/needs openrouter_api_key|add it in settings|missing api key|no api key/.test(text)) return "missing_credential";
  if (/is not installed|could not be found on this machine|command not found|enoent/.test(text)) return "provider_not_installed";
  if (/not signed in|login expired|run `codex login`|unauthorized|invalid api key|invalid_api_key|authentication/.test(text)) return "provider_auth";
  if (/quota|insufficient_quota|billing|payment required|out of credit|credit balance/.test(text)) return "provider_quota";
  if (/rate limit|rate_limit|too many requests|overloaded/.test(text)) return "provider_rate_limit";
  if (/context (?:length|window)|too many tokens|maximum context|context_length_exceeded|prompt is too long/.test(text)) return "context_overflow";
  if (/step tool limit|exceeded .* steps?/.test(text)) return "tool_step_limit";
  if (/malformed sse|incomplete sse|without response\.completed|before reporting a result|did not include a stream|ended without a result|invalid json/.test(text)) return "malformed_response";
  if (/fetch failed|network|socket hang up|econnrefused|econnreset|enotfound|etimedout|epipe|timed out|unreachable/.test(text)) return "provider_unavailable";

  const status = httpStatus(text);
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
// stays verbatim behind it for the person who has to act on the failure.
export function formatRoutedTurnFailure(error: unknown, reason = classifyRoutedTurnFailure(error)): string {
  return `[reason: ${reason}] Router error: ${routedTurnFailureMessage(error)}`;
}
