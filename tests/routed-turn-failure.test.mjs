import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const bundled = await build({
    entryPoints: [path.join(repoRoot, "source/shared/routed-turn-failure.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}

test("every routed failure the router itself raises classifies to a known reason", async () => {
  const { classifyRoutedTurnFailure, isRoutedTurnFailureReason } = await loadModule();

  // The left column is verbatim from the routed inference paths; a change there that stops
  // classifying should show up here rather than silently degrading to "unknown".
  const cases = [
    ["OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.", "missing_credential"],
    ["Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.", "provider_not_installed"],
    ["Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.", "provider_auth"],
    ["Codex login expired and could not be refreshed. Run `codex login` again.", "provider_auth"],
    ["Codex direct request failed (401: unauthorized).", "provider_auth"],
    ["Codex direct request failed (429: slow down).", "provider_rate_limit"],
    ["Codex direct request failed (503: upstream unavailable).", "provider_server_error"],
    ["Codex direct request failed (400: bad field).", "invalid_request"],
    ["Codex direct response contained malformed SSE JSON.", "malformed_response"],
    ["Codex direct response ended with an incomplete SSE event.", "malformed_response"],
    ["Codex direct response ended without response.completed.", "malformed_response"],
    ["Codex ended the routed turn before reporting a result.", "malformed_response"],
    ["Claude Code ended without a result.", "malformed_response"],
    ["Codex exceeded Grok Bot's 8-step tool limit.", "tool_step_limit"],
    ["Local inference routing requires an agentId and prompt", "invalid_request"],
    ["fetch failed", "provider_unavailable"],
    ["connect ECONNREFUSED 127.0.0.1:1340", "provider_unavailable"],
    ["This model's maximum context length is 200000 tokens", "context_overflow"],
    ["You exceeded your current quota, please check your billing details", "provider_quota"],
    ["something nobody has seen before", "unknown"],
  ];

  for (const [message, expected] of cases) {
    const reason = classifyRoutedTurnFailure(new Error(message));
    assert.equal(isRoutedTurnFailureReason(reason), true, `${reason} is outside the closed vocabulary`);
    assert.equal(reason, expected, `"${message}" classified as ${reason}`);
  }
});

test("no failure the routed paths raise degrades to an unclassified reason", async () => {
  const { classifyRoutedTurnFailure } = await loadModule();
  // The table above is transcribed by hand, so it keeps passing when a message is reworded in the
  // source and quietly stops classifying. These are the literals themselves, read out of the
  // routed inference paths at test time.
  const sources = [
    "source/host/extensions/inference/codex-direct-responses.ts",
    "source/host/extensions/inference/provider-session.ts",
    "source/node-agent-coordinator/inference-router.ts",
  ];
  const thrown = [];
  for (const relative of sources) {
    const source = await readFile(path.join(repoRoot, relative), "utf8");
    for (const match of source.matchAll(/throw new Error\((?:`|")([^`"$]+)(?:`|")\)/g)) thrown.push([relative, match[1]]);
  }

  assert.ok(thrown.length >= 8, `expected the routed paths to raise several classifiable failures, found ${thrown.length}`);
  for (const [relative, message] of thrown) {
    assert.notEqual(classifyRoutedTurnFailure(new Error(message)), "unknown", `${relative} raises "${message}", which no rule recognises`);
  }
});

test("a turn the person cancelled and a turn the app gave up on are not the same failure", async () => {
  const { ROUTED_TURN_TIMEOUT_ERROR_NAME, classifyRoutedTurnFailure, routedTurnRetryPolicy } = await loadModule();
  const aborted = new Error("The operation was aborted.");
  aborted.name = "AbortError";
  assert.equal(classifyRoutedTurnFailure(aborted), "cancelled");
  assert.equal(routedTurnRetryPolicy("cancelled"), "none");

  // A deadline this app imposed is the transient case the retry exists for. Borrowing `AbortError`
  // or `TimeoutError` for it would land it in the one class that suppresses that retry.
  const timedOut = new Error("codex stopped responding: Grok Bot timed out this turn after 600s.");
  timedOut.name = ROUTED_TURN_TIMEOUT_ERROR_NAME;
  assert.equal(classifyRoutedTurnFailure(timedOut), "provider_unavailable");
  assert.equal(routedTurnRetryPolicy("provider_unavailable"), "resume");
});

test("every reason in the vocabulary has a decided retry policy", async () => {
  const { ROUTED_TURN_FAILURE_REASONS, routedTurnRetryPolicy } = await loadModule();
  // Written out per reason rather than derived from the retryable list, so a reason added without
  // deciding what a retry should do with it fails here instead of inheriting an answer. A retry
  // resumes only where a second identical request could plausibly land differently.
  const expected = {
    missing_credential: "none",
    provider_not_installed: "none",
    provider_auth: "none",
    provider_quota: "none",
    provider_rate_limit: "resume",
    provider_server_error: "resume",
    provider_unavailable: "resume",
    context_overflow: "none",
    tool_step_limit: "none",
    malformed_response: "resume",
    invalid_request: "none",
    cancelled: "none",
    unknown: "none",
  };

  assert.deepEqual([...ROUTED_TURN_FAILURE_REASONS].sort(), Object.keys(expected).sort());
  for (const reason of ROUTED_TURN_FAILURE_REASONS) {
    assert.equal(routedTurnRetryPolicy(reason), expected[reason], `${reason} has the wrong retry policy`);
  }
});

test("a turn that already applied a plugin write is never retried", async () => {
  const { routedTurnRetryPolicy, formatRoutedTurnFailure } = await loadModule();
  const transient = new Error("Codex direct request failed (503: upstream unavailable).");

  // Replaying the prompt replays the tool calls with it, and nothing rolled the first ones
  // back, so a transient-looking failure is still a dead end once something has landed.
  assert.equal(routedTurnRetryPolicy("provider_server_error", { appliedWriteEffect: false }), "resume");
  assert.equal(routedTurnRetryPolicy("provider_server_error", { appliedWriteEffect: true }), "none");
  assert.equal(routedTurnRetryPolicy("provider_unavailable", { appliedWriteEffect: true }), "none");

  const reported = formatRoutedTurnFailure(transient, "provider_server_error", { appliedWriteEffect: true });
  assert.match(reported, /^\[reason: provider_server_error\]/);
  assert.match(reported, /already ran, so it was not retried automatically/);
});

test("a refusal's own status and pacing outrank the sentence built around them", async () => {
  const { classifyRoutedTurnFailure, routedTurnRetryDelayMs, MAX_ROUTED_RETRY_DELAY_MS } = await loadModule();

  // The message deliberately reads like nothing in particular: the annotation carries the truth.
  const rateLimited = Object.assign(new Error("the provider declined this request"), { status: 429, retryAfterMs: 4_000 });
  assert.equal(classifyRoutedTurnFailure(rateLimited), "provider_rate_limit");
  const paced = routedTurnRetryDelayMs(rateLimited, () => 0);
  assert.equal(paced, 4_000, "a server-paced retry waits at least as long as the server asked");

  const headerCarried = Object.assign(new Error("Provider refused"), { statusCode: 429, responseHeaders: { "Retry-After": "2" } });
  assert.equal(classifyRoutedTurnFailure(headerCarried), "provider_rate_limit");
  assert.equal(routedTurnRetryDelayMs(headerCarried, () => 0), 2_000);

  // `Retry-After: 0` carries no pacing; treating it as "now" would hot-loop the provider.
  assert.equal(routedTurnRetryDelayMs(Object.assign(new Error("429"), { retryAfterMs: 0 }), () => 0), 750);
  assert.equal(routedTurnRetryDelayMs(new Error("fetch failed"), () => 0), 750);
  assert.ok(routedTurnRetryDelayMs(new Error("fetch failed"), () => 1) > 750, "the wait is jittered, not fixed");

  // Waiting out a multi-minute reset behind a silent sleep is worse than failing with the
  // reason, and retrying before it only re-trips the limit.
  assert.equal(routedTurnRetryDelayMs(Object.assign(new Error("429"), { retryAfterMs: 120_000 })), null);
  assert.ok(routedTurnRetryDelayMs(Object.assign(new Error("429"), { retryAfterMs: MAX_ROUTED_RETRY_DELAY_MS }), () => 1) <= MAX_ROUTED_RETRY_DELAY_MS);
});

test("a formatted failure leads with a machine-readable reason and keeps the original text", async () => {
  const { formatRoutedTurnFailure } = await loadModule();
  assert.equal(
    formatRoutedTurnFailure(new Error("Codex direct request failed (429: slow down).")),
    "[reason: provider_rate_limit] Router error: Codex direct request failed (429: slow down).",
  );
});
