import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("routed transcript keeps a message when only its reactions are malformed", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "assistant",
          content: "hello",
          id: "t1s0",
          timestampMs: 123,
          reactions: [{ emoji: 1, by: "me" }, { emoji: "❤️", by: "me" }],
        }],
      },
    });
    assert.equal(store.agents.agent[0].content, "hello");
    assert.deepEqual(store.agents.agent[0].reactions, [{ emoji: "❤️", by: "me" }]);
    assert.equal(loaded.module.inspectInferenceRouterTranscriptStore({ schemaVersion: 1, agents: {} }).status, "unknown-schema");
  } finally {
    await loaded.dispose();
  }
});

test("sendPrompt validates input, canonicalizes nonce, and is idempotent", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-data-"));
  try {
    const events = [];
    let runs = 0;
    const settingsPath = path.join(temporary, "settings.json");
    await (await import("node:fs/promises")).writeFile(settingsPath, JSON.stringify({
      version: 1,
      inferenceProvider: "codex",
    }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail" || method === "openAgentTail" || method === "getAgentTranscriptWindow") {
          return { entries: [] };
        }
        if (method === "listAgents") return [{ id: "agent" }];
        if (method === "listRoutedMcpTools") return [];
        return {};
      },
      now: () => 1_000,
      composeDelayMs: 0,
      runProvider: async () => {
        runs += 1;
        return "ok";
      },
    });
    const missing = await router.dispatch("sendPrompt", { agentId: "", prompt: "" });
    assert.equal(missing.value.accepted, false);
    const first = await router.dispatch("sendPrompt", { agentId: "agent", prompt: "hi", clientNonce: "n1" });
    assert.equal(first.value.accepted, true);
    assert.equal(first.value.clientNonce, "n1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await router.dispatch("sendPrompt", { agentId: "agent", prompt: "hi", clientNonce: "n1" });
    assert.equal(second.value.accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs, 1);
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    assert.equal(tail.value.entries.filter((entry) => entry.role === "user" || entry.kind === "message").length, 1);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("failed routed turns keep streamed text on the same assistant id", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-fail-"));
  try {
    await (await import("node:fs/promises")).writeFile(path.join(temporary, "settings.json"), JSON.stringify({
      version: 1,
      inferenceProvider: "codex",
    }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent() {},
      dispatchRemote: async (method) => method === "listRoutedMcpTools" ? [] : { entries: [] },
      now: () => 2_000,
      composeDelayMs: 0,
      runProvider: async (_provider, _messages, options) => {
        options?.onTextDelta?.("partial", "partial");
        throw new Error("provider 500");
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent", prompt: "hi", clientNonce: "n2" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    const assistant = tail.value.entries.find((entry) => entry.kind === "send-message");
    assert.equal(assistant.id, "t0s0");
    assert.match(assistant.message.content, /partial/);
    assert.match(assistant.message.content, /provider 500/);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a damaged transcript is not replaced by an empty store", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-corrupt-"));
  try {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "codex" }));
    const storePath = path.join(temporary, "inference-router-transcript.json");
    await writeFile(storePath, "{not-json");
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent() {},
      dispatchRemote: async () => ({ entries: [] }),
      composeDelayMs: 0,
      runProvider: async () => "ok",
    });
    const result = await router.dispatch("sendPrompt", { agentId: "agent", prompt: "hi", clientNonce: "n3" });
    assert.equal(result.value.accepted, false);
    assert.match(String(result.value.error), /not valid JSON|could not be read|left unchanged/);
    assert.equal(await readFile(storePath, "utf8"), "{not-json");
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
