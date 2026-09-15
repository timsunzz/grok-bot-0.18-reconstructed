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

test("a resubmitted prompt does not run the turn twice", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seedProvider(loaded.dataDir, "openrouter");
    const { router } = harness(loaded.dataDir, loaded.module);

    await router.dispatch("sendPrompt", { agentId: "agent-2", prompt: "only once", clientNonce: "repeat" });
    await waitForAssistant(loaded.dataDir, "agent-2", 1);
    await router.dispatch("sendPrompt", { agentId: "agent-2", prompt: "only once", clientNonce: "repeat" });

    // Give the second dispatch the same budget the first one needed before concluding it ran.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const entries = await storedEntries(loaded.dataDir, "agent-2");
    assert.deepEqual(entries.map((entry) => entry.id), ["t0u", "t0s0"]);
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
