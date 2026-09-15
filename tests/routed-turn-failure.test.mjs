import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/shared/routed-turn-failure.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
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

test("an aborted turn is never mistaken for a provider failure", async () => {
  const { classifyRoutedTurnFailure, routedTurnRetryPolicy } = await loadModule();
  const aborted = new Error("The operation was aborted.");
  aborted.name = "AbortError";
  assert.equal(classifyRoutedTurnFailure(aborted), "cancelled");
  assert.equal(routedTurnRetryPolicy("cancelled"), "none");
});

test("only failures a retry can fix are retried", async () => {
  const { ROUTED_TURN_FAILURE_REASONS, routedTurnRetryPolicy } = await loadModule();
  const retried = ROUTED_TURN_FAILURE_REASONS.filter((reason) => routedTurnRetryPolicy(reason) === "resume");

  assert.deepEqual(retried, ["provider_rate_limit", "provider_server_error", "provider_unavailable", "malformed_response"]);
  // Retrying these can only burn a second provider request: nothing about them changes between
  // two back-to-back attempts.
  for (const reason of ["missing_credential", "provider_not_installed", "provider_auth", "provider_quota", "context_overflow", "tool_step_limit", "invalid_request", "cancelled", "unknown"]) {
    assert.equal(routedTurnRetryPolicy(reason), "none", `${reason} should not be retried`);
  }
});

test("a formatted failure leads with a machine-readable reason and keeps the original text", async () => {
  const { formatRoutedTurnFailure } = await loadModule();
  assert.equal(
    formatRoutedTurnFailure(new Error("Codex direct request failed (429: slow down).")),
    "[reason: provider_rate_limit] Router error: Codex direct request failed (429: slow down).",
  );
});
