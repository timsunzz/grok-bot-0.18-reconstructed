import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The routed providers cannot be driven offline, so the coordinator is bundled against a stub
// provider session that the test scripts directly: it runs whatever tool calls a case needs and
// then fails however that case needs it to fail.
const STUB = `export async function runRoutedProviderText(provider, messages, options) {
  return await globalThis.__routedProviderStub(provider, messages, options);
}
`;

async function loadRouter() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-side-effects-"));
  const stubPath = path.join(temporary, "provider-session-stub.mjs");
  await writeFile(stubPath, STUB);
  const outfile = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [{
      name: "stub-provider-session",
      setup(builder) {
        builder.onResolve({ filter: /inference\/provider-session\.js$/ }, () => ({ path: stubPath }));
      },
    }],
  });
  process.env.SAND_DATA_ROOT = path.join(temporary, "sand-root");
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dataDir: path.join(temporary, "data"), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const WRITE_TOOL = { name: "send_email", providerIdentifier: "gmail", toolName: "send_email", description: "Send an email" };
const READ_TOOL = { name: "search_email", providerIdentifier: "gmail", toolName: "search_email", description: "Search email" };

const SUCCESS = { result: { case: "success", value: { content: [], isError: false } } };
const REJECTED = { result: { case: "error", value: { error: "the plugin said no" } } };

async function seed(dataDir) {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }, null, 2));
}

function harness(dataDir, module, tools, toolReply = () => SUCCESS) {
  const executed = [];
  const router = module.createCoordinatorInferenceRouter({
    dataDir,
    postEvent: () => {},
    dispatchRemote: async (method, args) => {
      if (method === "getAgentTranscriptTail") return { entries: [] };
      if (method === "listRoutedMcpTools") return tools;
      if (method === "listAgents") return [];
      if (method === "executeRoutedMcpTool") { executed.push(args); return toolReply(args); }
      return null;
    },
    now: () => 1_000,
  });
  return { router, executed };
}

async function assistantEntry(dataDir, agentId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
      const entry = (store.agents?.[agentId] ?? []).find((row) => row.role === "assistant");
      if (entry != null) return entry;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no assistant entry after ${timeoutMs}ms`);
}

test("a turn that already sent something is not replayed by the retry", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seed(loaded.dataDir);
    const { router, executed } = harness(loaded.dataDir, loaded.module, [WRITE_TOOL]);

    let attempts = 0;
    globalThis.__routedProviderStub = async (_provider, _messages, options) => {
      attempts += 1;
      await options.executeTool(WRITE_TOOL, { to: "someone" }, `call-${attempts}`);
      throw Object.assign(new Error("Codex direct request failed (503: upstream unavailable)."), { status: 503 });
    };

    await router.dispatch("sendPrompt", { agentId: "agent-write", prompt: "mail them", clientNonce: "n1" });
    const entry = await assistantEntry(loaded.dataDir, "agent-write");

    // Without this guard the second attempt sends the mail again, and the failure it recovers
    // from is exactly the kind that leaves the first send's outcome unknown.
    assert.equal(attempts, 1, "the failed turn was retried after a write already went out");
    assert.equal(executed.length, 1);
    assert.match(entry.content, /^\[reason: provider_server_error\]/);
    assert.match(entry.content, /already ran, so it was not retried automatically/);
  } finally {
    delete globalThis.__routedProviderStub;
    await loaded.dispose();
  }
});

test("a turn that only read still gets its retry", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seed(loaded.dataDir);
    const { router, executed } = harness(loaded.dataDir, loaded.module, [READ_TOOL]);

    let attempts = 0;
    globalThis.__routedProviderStub = async (_provider, _messages, options) => {
      attempts += 1;
      await options.executeTool(READ_TOOL, { query: "receipts" }, `call-${attempts}`);
      if (attempts === 1) throw Object.assign(new Error("Codex direct request failed (503: upstream unavailable)."), { status: 503 });
      return "found three receipts";
    };

    await router.dispatch("sendPrompt", { agentId: "agent-read", prompt: "find receipts", clientNonce: "n2" });
    const entry = await assistantEntry(loaded.dataDir, "agent-read");

    assert.equal(attempts, 2, "a repeatable read should not cost the turn its retry");
    assert.equal(executed.length, 2);
    assert.equal(entry.content, "found three receipts");
  } finally {
    delete globalThis.__routedProviderStub;
    await loaded.dispose();
  }
});

test("a plugin failing every call stops being dispatched to", { timeout: 90_000 }, async () => {
  const loaded = await loadRouter();
  try {
    await seed(loaded.dataDir);
    const { router, executed } = harness(loaded.dataDir, loaded.module, [READ_TOOL], () => REJECTED);

    const answers = [];
    globalThis.__routedProviderStub = async (_provider, _messages, options) => {
      for (let call = 0; call < 5; call += 1) answers.push(await options.executeTool(READ_TOOL, {}, `call-${call}`));
      return "gave up on the plugin";
    };

    await router.dispatch("sendPrompt", { agentId: "agent-breaker", prompt: "keep trying", clientNonce: "n3" });
    await assistantEntry(loaded.dataDir, "agent-breaker");

    // The model is free to keep asking; the point is that asking stops costing a host round trip
    // and starts returning an answer that tells it to stop.
    assert.equal(executed.length, 3, "the breaker should have opened after three failures");
    assert.equal(answers.length, 5);
    for (const refused of answers.slice(3)) {
      assert.match(refused.result.value.error, /rejected the last 3 calls/);
    }
  } finally {
    delete globalThis.__routedProviderStub;
    await loaded.dispose();
  }
});
