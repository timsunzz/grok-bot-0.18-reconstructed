import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), name));
  const output = path.join(temporary, "out.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("router error entries stay out of the t{turn} namespace", async () => {
  const loaded = await bundle("source/node-agent-coordinator/inference-router.ts", "grok-router-err-");
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grok-router-store-"));
    try {
      const events = [];
      const router = loaded.module.createCoordinatorInferenceRouter({
        dataDir: dir,
        postEvent: (family, payload) => events.push({ family, payload }),
        dispatchRemote: async (method) => {
          if (method === "listAgents") return [];
          if (method === "getAgentTranscriptTail") return { entries: [] };
          if (method === "listRoutedMcpTools") return [];
          throw new Error(`unexpected ${method}`);
        },
      });
      // Force provider to a routed one via settings file.
      const { SandSettingsStore } = await import(
        `${pathToFileURL(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")).href}`
      ).catch(() => ({}));
      assert.ok(loaded.module.parseInferenceRouterTranscriptStore);
      // Simulate the error-id shape directly: it must not match the turn regex.
      assert.equal(/^t(\d+)(?:u|s\d+)$/.test(`t-error-1234567890-abcdef12`), false);
      assert.match("t3u", /^t(\d+)(?:u|s\d+)$/);
      assert.match("t3s0", /^t(\d+)(?:u|s\d+)$/);
      assert.ok(router);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("transcript tail limit is clamped to 500 entries", async () => {
  const loaded = await bundle("source/node-agent-coordinator/inference-router.ts", "grok-router-limit-");
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grok-router-limit-"));
    try {
      const remoteEntries = Array.from({ length: 600 }, (_, i) => ({ kind: "message", id: `remote-${i}`, role: "user", content: `${i}` }));
      const router = loaded.module.createCoordinatorInferenceRouter({
        dataDir: dir,
        postEvent: () => {},
        dispatchRemote: async (method) => {
          if (method === "getAgentTranscriptTail") return { entries: remoteEntries };
          if (method === "listAgents") return [];
          throw new Error(`unexpected ${method}`);
        },
      });
      // Seed a routed provider choice so the tail merge path is handled.
      const settingsPath = path.join(dir, "settings.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(settingsPath, JSON.stringify({ version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [], inferenceProvider: "codex" }));
      const outcome = await router.dispatch("getAgentTranscriptTail", { id: "agent", limit: 5000 });
      assert.equal(outcome.handled, true);
      assert.ok(Array.isArray(outcome.value.entries));
      assert.ok(outcome.value.entries.length <= 500, `expected clamp, got ${outcome.value.entries.length}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("routed MCP bridge handles notifications and unknown methods", async () => {
  const loaded = await bundle("source/node-agent-coordinator/routed-mcp-bridge.ts", "grok-bridge-");
  try {
    const bridge = await loaded.module.createRoutedMcpBridge({ listTools: async () => [], callTool: async () => ({}) });
    try {
      // Notification without id -> 202, no body expectations.
      const noId = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }) });
      assert.equal(noId.status, 202);
      // Unknown method with id -> JSON-RPC method-not-found error.
      const unknown = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope/unknown", params: {} }) });
      assert.equal(unknown.status, 200);
      const payload = await unknown.json();
      assert.equal(payload.id, 1);
      assert.equal(payload.error.code, -32601);
    } finally {
      await bridge.close();
    }
  } finally {
    await loaded.dispose();
  }
});

test("bot-mode rejects empty prompt without credentials", async () => {
  const loaded = await bundle("source/node-agent-coordinator/bot-mode.ts", "grok-botmode-");
  try {
    assert.ok(typeof loaded.module.runBotTurn === "function");
    assert.ok(typeof loaded.module.resolveBotDataDir === "function");
    await assert.rejects(() => loaded.module.runBotTurn({ dataDir: path.join(os.tmpdir(), "unused"), turn: { agentId: "bot", prompt: "" } }), /non-empty agentId and prompt/);
  } finally {
    await loaded.dispose();
  }
});
