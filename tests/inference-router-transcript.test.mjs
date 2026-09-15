import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
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

async function createRoutedRouter(loaded, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-data-"));
  await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({
    version: 1,
    inferenceProvider: "codex",
  }, null, 2)}\n`);
  const events = [];
  const router = loaded.module.createCoordinatorInferenceRouter({
    dataDir,
    postEvent: (family, payload) => events.push({ family, payload }),
    dispatchRemote: async (method) => method === "listRoutedMcpTools" ? [] : { entries: [] },
    composingDelayMs: 0,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    ...overrides,
  });
  return {
    router,
    events,
    dataDir,
    dispose: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

test("routed sendPrompt rejects empty input without claiming acceptance", async () => {
  const loaded = await loadModule();
  const routed = await createRoutedRouter(loaded, {
    runProvider: async () => { throw new Error("provider should not run"); },
  });
  try {
    const result = await routed.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "" });
    assert.equal(result.handled, true);
    assert.equal(result.value.accepted, false);
    assert.match(String(result.value.error), /agentId and prompt/);
  } finally {
    await routed.dispose();
    await loaded.dispose();
  }
});

test("routed sendPrompt coalesces duplicate clientNonce instead of repeating the turn", async () => {
  const loaded = await loadModule();
  let runs = 0;
  const routed = await createRoutedRouter(loaded, {
    runProvider: async () => {
      runs += 1;
      return "first answer";
    },
  });
  try {
    const first = await routed.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "nonce-dup" });
    await routed.router.whenIdle("agent-1");
    const second = await routed.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "nonce-dup" });
    await routed.router.whenIdle("agent-1");
    assert.equal(first.value.accepted, true);
    assert.equal(second.value.accepted, true);
    assert.equal(second.value.coalesced, true);
    assert.equal(runs, 1);
  } finally {
    await routed.dispose();
    await loaded.dispose();
  }
});

test("routed sendPrompt retries transient provider failures then records a classified error", async () => {
  const loaded = await loadModule();
  let attempts = 0;
  const routed = await createRoutedRouter(loaded, {
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    runProvider: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNRESET");
      return "recovered";
    },
  });
  try {
    const result = await routed.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "retry please", clientNonce: "nonce-retry" });
    await routed.router.whenIdle("agent-1");
    assert.equal(result.value.accepted, true);
    assert.equal(attempts, 3);
    const assistant = routed.events.filter((event) => event.family === "transcript" && event.payload.entry?.kind === "send-message").at(-1);
    assert.equal(assistant.payload.entry.message.content, "recovered");
  } finally {
    await routed.dispose();
    await loaded.dispose();
  }
});

test("routed sendPrompt times out hung providers and writes a classified assistant error", async () => {
  const loaded = await loadModule();
  const routed = await createRoutedRouter(loaded, {
    turnTimeoutMs: 20,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    runProvider: (_provider, _messages, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  try {
    await routed.router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hang", clientNonce: "nonce-timeout" });
    await routed.router.whenIdle("agent-1");
    const assistant = routed.events.filter((event) => event.family === "transcript" && event.payload.entry?.kind === "send-message").at(-1);
    assert.match(String(assistant.payload.entry.message.content), /Router error \(codex\/timeout\)/);
  } finally {
    await routed.dispose();
    await loaded.dispose();
  }
});
