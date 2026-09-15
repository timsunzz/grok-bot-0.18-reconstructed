import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRouter() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-turn-recovery-"));
  const outfile = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  // OpenRouter is the one routed provider that fails deterministically offline: with no key in
  // the environment and an empty data root it has no credential to find.
  process.env.SAND_DATA_ROOT = path.join(temporary, "sand-root");
  delete process.env.OPENROUTER_API_KEY;
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dataDir: path.join(temporary, "data"), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function seedProvider(dataDir, provider) {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: provider }, null, 2));
}

function harness(dataDir, module) {
  const events = [];
  const router = module.createCoordinatorInferenceRouter({
    dataDir,
    postEvent: (family, payload) => events.push({ family, payload }),
    dispatchRemote: async (method) => {
      if (method === "getAgentTranscriptTail") return { entries: [] };
      if (method === "listRoutedMcpTools") return [];
      if (method === "listAgents") return [];
      return null;
    },
    now: () => 1_000,
  });
  return { router, events };
}

async function storedEntries(dataDir, agentId) {
  try {
    const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
    return store.agents?.[agentId] ?? [];
  } catch { return []; }
}

async function waitForAssistant(dataDir, agentId, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await storedEntries(dataDir, agentId);
    if (entries.filter((entry) => entry.role === "assistant").length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no assistant entry after ${timeoutMs}ms: ${JSON.stringify(await storedEntries(dataDir, agentId))}`);
}

test("a failed routed turn keeps the transcript's turn numbering intact", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    const { router } = harness(loaded.dataDir, loaded.module);

    assert.deepEqual(
      await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "first", clientNonce: "nonce-1" }),
      { handled: true, value: { accepted: true, clientNonce: "nonce-1", provider: "openrouter" } },
    );
    const afterFirst = await waitForAssistant(loaded.dataDir, "agent-1", 1);

    assert.deepEqual(afterFirst.map((entry) => entry.id), ["t0u", "t0s0"]);
    assert.match(afterFirst[1].content, /^\[reason: missing_credential\] Router error: OpenRouter needs OPENROUTER_API_KEY/);

    // The failure entry used to be numbered `t${Date.now()}s0`, which fed epoch milliseconds
    // into the turn counter and left every later turn permanently misordered.
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "second", clientNonce: "nonce-2" });
    const afterSecond = await waitForAssistant(loaded.dataDir, "agent-1", 2);
    assert.deepEqual(afterSecond.map((entry) => entry.id), ["t0u", "t0s0", "t1u", "t1s0"]);
  } finally {
    await loaded.dispose();
  }
});

async function seedTranscript(dataDir, agentId, entries) {
  await writeFile(
    path.join(dataDir, "inference-router-transcript.json"),
    JSON.stringify({ schemaVersion: 2, agents: { [agentId]: entries.map((entry) => ({ provider: "openrouter", timestampMs: 1_000, ...entry })) } }, null, 2),
  );
}

test("a prompt that was already answered is not run again", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    await seedTranscript(loaded.dataDir, "agent-2", [
      { role: "user", content: "only once", id: "t0u", clientNonce: "repeat" },
      { role: "assistant", content: "answered once", id: "t0s0" },
    ]);
    const { router } = harness(loaded.dataDir, loaded.module);

    // A resubmission carries the nonce of the submission it repeats, which is how the desktop
    // recovers from a dropped acknowledgement. Running it again would duplicate the turn.
    await router.dispatch("sendPrompt", { agentId: "agent-2", prompt: "only once", clientNonce: "repeat" });

    // Give the dispatch the budget a real turn needs before concluding it did not run.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.deepEqual((await storedEntries(loaded.dataDir, "agent-2")).map((entry) => entry.id), ["t0u", "t0s0"]);
  } finally {
    await loaded.dispose();
  }
});

test("a prompt whose turn failed can be sent again under the same nonce", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    await seedTranscript(loaded.dataDir, "agent-4", [
      { role: "user", content: "try again", id: "t0u", clientNonce: "resend" },
      { role: "assistant", content: "[reason: provider_rate_limit] Router error: rate limit exceeded", id: "t0s0", failureReason: "provider_rate_limit" },
    ]);
    const { router } = harness(loaded.dataDir, loaded.module);

    // Resending a failed turn is what the desktop's `resendFailed` does, and it reuses the nonce.
    // Deduplicating on the prompt alone refused to run it and said nothing about why, so the
    // person's only recovery was to retype the message.
    await router.dispatch("sendPrompt", { agentId: "agent-4", prompt: "try again", clientNonce: "resend" });
    const entries = await waitForAssistant(loaded.dataDir, "agent-4", 2);

    assert.deepEqual(entries.map((entry) => entry.id), ["t0u", "t0s0", "t1u", "t1s0"]);
    assert.equal(entries[3].failureReason, "missing_credential");
  } finally {
    await loaded.dispose();
  }
});

test("a turn that fails before reaching the provider still answers its own prompt", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: loaded.dataDir,
      postEvent: (family, payload) => events.push({ family, payload }),
      // Listing the plugin tools happens after the prompt is recorded, so its failure is reported
      // by the queue rather than by the turn itself.
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listRoutedMcpTools") throw new Error("the plugin host is not running");
        if (method === "listAgents") return [{ id: "agent-5", isRunning: false }];
        return null;
      },
      now: () => 1_000,
    });

    await router.dispatch("sendPrompt", { agentId: "agent-5", prompt: "hello", clientNonce: "nonce-5" });
    const entries = await waitForAssistant(loaded.dataDir, "agent-5", 1);

    // The reply used to be filed at the next turn, one ahead of the prompt it was answering,
    // leaving that prompt looking permanently unanswered.
    assert.deepEqual(entries.map((entry) => entry.id), ["t0u", "t0s0"]);
    assert.match(entries[1].content, /the plugin host is not running/);

    // The turn also has to stop claiming to be running. The composing state is republished four
    // times a second precisely so a stale remote roster cannot erase it, so a failure that skips
    // the clear leaves that agent composing for the rest of the session.
    const rosters = () => events.filter((event) => event.family === "agents");
    const published = rosters().length;
    const settled = rosters().at(-1).payload.agents.find((agent) => agent.id === "agent-5");
    assert.equal(settled.isRunning, false);
    assert.equal(settled.currentActivity, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(rosters().length, published, "the activity pulse has to have stopped");
  } finally {
    await loaded.dispose();
  }
});

test("a reused nonce carrying different text still runs", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    const { router } = harness(loaded.dataDir, loaded.module);

    await router.dispatch("sendPrompt", { agentId: "agent-3", prompt: "first text", clientNonce: "shared" });
    await waitForAssistant(loaded.dataDir, "agent-3", 1);
    await router.dispatch("sendPrompt", { agentId: "agent-3", prompt: "different text", clientNonce: "shared" });
    const entries = await waitForAssistant(loaded.dataDir, "agent-3", 2);

    // Dropping a real message would be worse than an extra turn, so deduplication needs both
    // the nonce and the text to match.
    assert.deepEqual(entries.map((entry) => entry.content).filter((_, index) => index % 2 === 0), ["first text", "different text"]);
  } finally {
    await loaded.dispose();
  }
});
