import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRouter() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-turn-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function seedProvider(dataDir, provider = "codex") {
  await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({
    version: 1,
    mcpBoxServers: [],
    autoUpdateWhenIdleOptIn: false,
    egressTunnelEnabled: false,
    webauthnProxyEnabled: true,
    mcpCustomInstructions: {},
    mcpCustomInstructionsByServerId: {},
    mcpDisabledToolsByServerId: {},
    conciergeConsent: "unset",
    settingsMigrations: ["downgrade-persisted-max-fast"],
    inferenceProvider: provider,
  }, null, 2)}\n`);
}

test("routed turns reject empty prompts, retry transients, and keep sequential failure ids", async () => {
  const loaded = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-data-"));
  try {
    await seedProvider(dataDir);
    const events = [];
    let attempts = 0;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async method => method.includes("Transcript") ? { entries: [] } : [],
      composeDelayMs: 0,
      retryDelayMs: 0,
      turnTimeoutMs: 5_000,
      assertReady: () => {},
      runProvider: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("429 rate limit");
        return "recovered";
      },
    });

    const empty = await router.dispatch("sendPrompt", { agentId: "agent", prompt: "" });
    assert.equal(empty.handled, true);
    assert.equal(empty.value.accepted, false);
    assert.equal(empty.value.reason, "invalid_request");

    const first = await router.dispatch("sendPrompt", { agentId: "agent", prompt: "hello", clientNonce: "n1" });
    assert.equal(first.value.accepted, true);
    await router.waitUntilIdle("agent");
    assert.equal(attempts, 2);
    const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
    assert.deepEqual(store.agents.agent.map(entry => entry.id), ["t0u", "t0s0"]);
    assert.equal(store.agents.agent[1].content, "recovered");

    let failed = 0;
    const failing = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async method => method.includes("Transcript") ? { entries: [] } : [],
      composeDelayMs: 0,
      retryDelayMs: 0,
      turnTimeoutMs: 5_000,
      assertReady: () => {},
      runProvider: async () => {
        failed += 1;
        throw new Error("401 unauthorized");
      },
    });
    await failing.dispatch("sendPrompt", { agentId: "agent", prompt: "again", clientNonce: "n2" });
    await failing.waitUntilIdle("agent");
    assert.equal(failed, 1);
    const after = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
    assert.deepEqual(after.agents.agent.map(entry => entry.id), ["t0u", "t0s0", "t1u", "t1s0"]);
    assert.match(after.agents.agent[3].content, /\[provider_auth_or_access\]/);
    assert.ok(events.some(event => event.family === "transcript" && event.payload.entry?.id === "t0s0"));
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a mid-stream provider failure updates the same assistant entry", async () => {
  const loaded = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-stream-"));
  try {
    await seedProvider(dataDir);
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async method => method.includes("Transcript") ? { entries: [] } : [],
      composeDelayMs: 0,
      retryDelayMs: 0,
      turnTimeoutMs: 5_000,
      assertReady: () => {},
      runProvider: async (_provider, _messages, options) => {
        options.onTextDelta("partial", "partial");
        throw new Error("502 server error");
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent", prompt: "stream", clientNonce: "n3" });
    await router.waitUntilIdle("agent");
    const assistantEvents = events.filter(event => event.payload?.entry?.id === "t0s0");
    assert.equal(assistantEvents.some(event => event.payload.type === "appended"), true);
    assert.equal(assistantEvents.some(event => event.payload.type === "updated"), true);
    const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
    assert.deepEqual(store.agents.agent.map(entry => entry.id), ["t0u", "t0s0"]);
    assert.match(store.agents.agent[1].content, /\[provider_server_error\]/);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("transcript mutations stay serialized across a reaction during a turn", async () => {
  const loaded = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-race-"));
  try {
    await seedProvider(dataDir);
    let router;
    router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async method => method.includes("Transcript") ? { entries: [] } : [],
      composeDelayMs: 0,
      retryDelayMs: 0,
      turnTimeoutMs: 5_000,
      assertReady: () => {},
      runProvider: async () => {
        await router.dispatch("reactToMessage", { agentId: "agent", entryId: "t0u", emoji: "👍" });
        return "done";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent", prompt: "react", clientNonce: "n4" });
    await router.waitUntilIdle("agent");
    const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
    assert.deepEqual(store.agents.agent[0].reactions, [{ emoji: "👍", by: "me" }]);
    assert.equal(store.agents.agent[1].content, "done");
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
