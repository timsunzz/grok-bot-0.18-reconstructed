import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRuntime() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-runtime-"));
  const output = path.join(temporary, "runtime.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/inference-router-runtime.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

test("transcript turns stay sequential and reject Date.now-sized error ids", async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.nextTranscriptTurn(["t0u", "t0s0"], ["t3u"]), 4);
  assert.equal(runtime.userEntryId(4), "t4u");
  assert.equal(runtime.assistantEntryId(4), "t4s0");
  assert.equal(runtime.transcriptTurnIndex(`t${Date.now()}s0`), null);
  assert.equal(runtime.highestTranscriptTurn([`t${Date.now()}s0`, "t2s0"]), 2);
});

test("provider failures classify like Hermes bot-mode reason codes", async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.classifyProviderFailure(new Error("429 rate limit")), "provider_rate_limit");
  assert.equal(runtime.classifyProviderFailure(new Error("401 unauthorized")), "provider_auth_or_access");
  assert.equal(runtime.classifyProviderFailure(new Error("OpenRouter needs OPENROUTER_API_KEY")), "provider_auth_or_access");
  assert.equal(runtime.classifyProviderFailure(new Error("Claude Code is not installed")), "missing_config");
  assert.equal(runtime.classifyProviderFailure(new Error("ECONNREFUSED 127.0.0.1")), "runtime_offline");
  assert.equal(runtime.classifyProviderFailure(new Error("Routed inference timed out after 10ms.")), "delivery_timeout");
  assert.equal(runtime.isTransientProviderFailure("provider_rate_limit"), true);
  assert.equal(runtime.isTransientProviderFailure("provider_auth_or_access"), false);
  assert.match(runtime.formatRouterError(new Error("boom"), "unknown"), /\[unknown\]: boom/);
});

test("tool and conversation loop guards trip then cool down", async () => {
  const runtime = await loadRuntime();
  const tools = new runtime.ToolLoopGuard(2);
  assert.equal(tools.admit("search", { q: "a" }).allowed, true);
  assert.equal(tools.admit("search", { q: "a" }).allowed, true);
  assert.equal(tools.admit("search", { q: "a" }).allowed, false);

  let now = 1_000;
  const turns = new runtime.ConversationLoopGuard(2, 1_000, 5_000, () => now);
  assert.equal(turns.admit("agent").allowed, true);
  assert.equal(turns.admit("agent").allowed, true);
  assert.deepEqual(turns.admit("agent"), { allowed: false, state: "tripped" });
  assert.deepEqual(turns.admit("agent"), { allowed: false, state: "cooldown" });
  now += 6_000;
  assert.equal(turns.admit("agent").allowed, true);
});

test("turn timeout aborts the in-flight operation", async () => {
  const runtime = await loadRuntime();
  await assert.rejects(
    () => runtime.withTurnTimeout(signal => runtime.sleep(50, signal), 5),
    /timed out/,
  );
});
