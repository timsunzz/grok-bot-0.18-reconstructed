import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-robust-"));
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

async function writeRoutedSettings(dataDir) {
  await mkdir(dataDir, { recursive: true });
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
    inferenceProvider: "openrouter",
  }, null, 2)}\n`);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for routed transcript");
}

test("malformed reactions no longer drop an otherwise valid transcript entry", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "keep me",
          id: "t1u",
          timestampMs: 123,
          reactions: [{ emoji: "🔥" }],
        }],
      },
    });
    assert.equal(store.agents.agent[0].content, "keep me");
    assert.equal(store.agents.agent[0].reactions, undefined);
  } finally {
    await loaded.dispose();
  }
});

test("turn numbering only counts t<n>u / t<n>s<k> ids", async () => {
  const loaded = await loadModule();
  try {
    assert.equal(loaded.module.highestTranscriptTurn(["t3u", "t3s0"]), 3);
    assert.equal(loaded.module.highestTranscriptTurn(["t1u", "not-a-turn", "t12s0"]), 12);
    assert.equal(loaded.module.highestTranscriptTurn([]), -1);
  } finally {
    await loaded.dispose();
  }
});

test("failed routed turns keep sequential ids, classify the error, and honor clientNonce", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-data-"));
  await writeRoutedSettings(dataDir);
  process.env.GROK_BOT_ROUTER_COMPOSE_DELAY_MS = "0";
  try {
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedMcpTools") return [];
        throw new Error("unexpected remote " + method);
      },
      now: () => 1_000,
    });
    const first = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello", clientNonce: "nonce-1" });
    assert.equal(first.handled, true);
    await waitFor(async () => {
      const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
      return tail.value.entries.some(entry => entry.kind === "send-message");
    });
    const second = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello again", clientNonce: "nonce-1" });
    assert.equal(second.value.accepted, true);
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    const entries = tail.value.entries.filter(entry => entry.kind === "message" || entry.kind === "send-message");
    const userEntries = entries.filter(entry => entry.kind === "message");
    assert.equal(userEntries.length, 1, "duplicate clientNonce must not append another user turn");
    assert.equal(userEntries[0].id, "t0u");
    const assistant = entries.find(entry => entry.kind === "send-message");
    assert.equal(assistant.id, "t0s0");
    assert.match(assistant.message.content, /\[reason:/);
    assert.doesNotMatch(assistant.id, /^t1\d{12}s0$/);
  } finally {
    delete process.env.GROK_BOT_ROUTER_COMPOSE_DELAY_MS;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("concurrent appends for different agents do not drop transcript rows", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-race-"));
  await writeRoutedSettings(dataDir);
  process.env.GROK_BOT_ROUTER_COMPOSE_DELAY_MS = "0";
  try {
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "a" }, { id: "b" }];
        if (method === "listRoutedMcpTools") return [];
        throw new Error("unexpected remote " + method);
      },
    });
    await Promise.all([
      router.dispatch("sendPrompt", { agentId: "a", prompt: "from a", clientNonce: "a1" }),
      router.dispatch("sendPrompt", { agentId: "b", prompt: "from b", clientNonce: "b1" }),
    ]);
    await waitFor(async () => {
      const a = await router.dispatch("getAgentTranscriptTail", { id: "a" });
      const b = await router.dispatch("getAgentTranscriptTail", { id: "b" });
      return a.value.entries.some(entry => entry.content === "from a") && b.value.entries.some(entry => entry.content === "from b");
    });
  } finally {
    delete process.env.GROK_BOT_ROUTER_COMPOSE_DELAY_MS;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});
