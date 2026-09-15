import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadProviderSession() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-provider-"));
  const outfile = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/provider-session.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const codexHome = path.join(temporary, "codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "at", refresh_token: "rt", id_token: "it", account_id: "acct" },
  }), { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
  process.env.SAND_DATA_ROOT = path.join(temporary, "sand");
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function sse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function truncatedStream() {
  return sse('data: {"type":"response.output_text.delta"');
}

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}

async function withoutUnhandledRejections(run) {
  const observed = [];
  const record = (reason) => observed.push(reason instanceof Error ? reason.message : String(reason));
  process.on("unhandledRejection", record);
  try {
    await run();
    // Rejections are reported on a later turn of the event loop than the throw that caused them.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    process.off("unhandledRejection", record);
  }
  return observed;
}

test("a failed routed turn rejects its caller without leaving unobserved rejections", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    let thrown = null;
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(async () => truncatedStream(), async () => {
      await assert.rejects(
        loaded.module.runRoutedProviderText("codex", [{ role: "user", content: "hi" }]),
        (error) => { thrown = error.message; return /incomplete SSE event/.test(error.message); },
      );
    }));

    assert.equal(thrown, "Codex direct response ended with an incomplete SSE event.");
    // `usage`, `extendedUsage` and `providerMetadata` are side channels a caller may ignore.
    // Rejecting them without a handler used to raise unhandledRejection, which the coordinator
    // reports as a fatal crash and exits on, so a single failed turn killed the process.
    assert.deepEqual(observed, []);
  } finally {
    await loaded.dispose();
  }
});

test("abandoning a routed stream settles its side channels instead of hanging", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    // A stream that delivers one delta and then never completes, standing in for a turn the
    // consumer abandons part-way through.
    const stalled = () => sse(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      },
    }));

    const observed = await withoutUnhandledRejections(() => withStubbedFetch(async () => stalled(), async () => {
      const session = loaded.module.createProviderPromptSession("codex");
      const result = session.getExecutor().stream(undefined, "invocation-1");
      const iterator = result.fullStream[Symbol.asyncIterator]();

      assert.deepEqual(await iterator.next(), { done: false, value: { type: "text-delta", textDelta: "partial" } });
      await iterator.return();

      for (const channel of [result.response, result.usage, result.extendedUsage, result.providerMetadata]) {
        await assert.rejects(channel, /before reporting a result/);
      }
    }));

    assert.deepEqual(observed, []);
  } finally {
    await loaded.dispose();
  }
});

test("the routed Codex session does not advertise tools it cannot execute", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    const requests = [];
    await withoutUnhandledRejections(() => withStubbedFetch(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return sse('data: {"type":"response.completed","response":{"id":"resp-1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n');
    }, async () => {
      const session = loaded.module.createProviderPromptSession("codex");
      const result = session.getExecutor().stream(undefined, "invocation-1", [
        { name: "gmail_search", description: "Search Gmail", inputSchema: { type: "object" } },
      ]);
      for await (const _event of result.fullStream) { /* drain */ }
      await result.response;
    }));

    assert.equal(requests.length, 1);
    // This executor never surfaces tool-call parts on `fullStream`, so it has no way to run a
    // tool. Declaring one anyway made the transport fail the whole turn the moment the model
    // asked for it; answering as text is the better degradation.
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].tool_choice, undefined);
  } finally {
    await loaded.dispose();
  }
});
