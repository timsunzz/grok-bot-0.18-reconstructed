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
  const failureOutfile = path.join(temporary, "routed-turn-failure.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/routed-turn-failure.ts")],
    outfile: failureOutfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  process.env.CODEX_HOME = codexHome;
  process.env.SAND_DATA_ROOT = path.join(temporary, "sand");
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  const failure = await import(`${pathToFileURL(failureOutfile).href}?${Date.now()}`);
  return { module, classify: failure.classifyRoutedTurnFailure, retryDelayMs: failure.routedTurnRetryDelayMs, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function sse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// One OpenAI-compatible streamed completion, which is what OpenRouter answers with.
function completion(deltas) {
  const chunks = deltas.map(([delta, finishReason]) => `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai/gpt-5.2",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`);
  return sse(`${chunks.join("")}data: [DONE]\n\n`);
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

// A response that opens its stream, sends whatever it is given, and then says nothing more. The
// socket stays up, so no network error ever arrives.
function goesQuiet(...events) {
  return (_url, init) => {
    goesQuiet.signal = init.signal;
    return Promise.resolve(sse(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    })));
  };
}

test("a provider that stops responding loses its turn instead of holding the queue", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    // The coordinator runs one routed turn per agent at a time, so a turn that waits here forever
    // silently swallows every later prompt for that agent.
    const started = Date.now();
    let failure = null;
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(goesQuiet(), async () => {
      await assert.rejects(
        loaded.module.runRoutedProviderText("codex", [{ role: "user", content: "hi" }], { idleTimeoutMs: 500 }),
        (error) => { failure = error; return true; },
      );
    }));

    assert.ok(Date.now() - started < 10_000, `gave up after ${Date.now() - started}ms`);
    assert.match(failure.message, /stopped responding/);
    // The provider request has to be closed too, or the turn is abandoned while its socket is not.
    assert.equal(goesQuiet.signal.aborted, true);
    // `AbortError` and `TimeoutError` are how a person cancelling a turn arrives, and a cancelled
    // turn is deliberately not retried. A deadline this app imposed is the transient case the
    // retry exists for, so it must not be mistaken for one.
    assert.equal(failure.name, "RoutedTurnTimeoutError");
    assert.equal(loaded.classify(failure), "provider_unavailable");
    assert.deepEqual(observed, []);
  } finally {
    await loaded.dispose();
  }
});

test("a provider still working is not mistaken for one that has stopped", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    // Reasoning summaries are the provider's own account of a model that is thinking. This
    // transport handles them without reporting them onward, so a deadline watching only the text it
    // forwards sees a silence that is not there — and a total-duration cap sees one whatever
    // arrives. Six of these outlast the window three times over.
    const reasoning = Array.from({ length: 6 }, (_, index) => ({ type: "response.reasoning_summary_text.delta", delta: `step ${index}` }));
    const thinking = (_url, init) => Promise.resolve(sse(new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const event of reasoning) {
          if (init.signal?.aborted === true) break;
          await new Promise((resolve) => setTimeout(resolve, 120));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"here you go"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp-1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
        controller.close();
      },
    })));

    const observed = await withoutUnhandledRejections(() => withStubbedFetch(thinking, async () => {
      const answer = await loaded.module.runRoutedProviderText("codex", [{ role: "user", content: "hi" }], { idleTimeoutMs: 250 });
      assert.equal(answer, "here you go");
    }));

    assert.deepEqual(observed, []);
  } finally {
    await loaded.dispose();
  }
});

test("the host's own agent turns get the same deadline", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    // Host agent turns are built through the prompt session rather than `runRoutedProviderText`,
    // and a provider that goes quiet strands them just as thoroughly: the turn never reports, and
    // nothing downstream can tell that from a model taking its time.
    process.env.SAND_ROUTED_IDLE_TIMEOUT_MS = "500";
    const started = Date.now();
    let failure = null;
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(goesQuiet({ type: "response.output_text.delta", delta: "half an ans" }), async () => {
      const session = loaded.module.createProviderPromptSession("codex");
      const result = session.getExecutor().stream(undefined, "invocation-1");
      await assert.rejects(async () => {
        for await (const _event of result.fullStream) { /* drain until the provider stops */ }
      }, (error) => { failure = error; return true; });
    }));

    assert.ok(Date.now() - started < 10_000, `gave up after ${Date.now() - started}ms`);
    assert.equal(failure.name, "RoutedTurnTimeoutError");
    assert.equal(goesQuiet.signal.aborted, true);
    assert.deepEqual(observed, []);
  } finally {
    delete process.env.SAND_ROUTED_IDLE_TIMEOUT_MS;
    await loaded.dispose();
  }
});

test("a reader taking its time is not a provider going quiet", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  try {
    // The provider said everything at once; it is the consumer that is slow, and what a consumer
    // does with a part it has already been handed is its own business. Cancelling a request that
    // answered in full because the reader was busy would be a worse bug than the one the deadline
    // fixes.
    process.env.SAND_ROUTED_IDLE_TIMEOUT_MS = "300";
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(async () => sse([
      'data: {"type":"response.output_text.delta","delta":"one"}',
      'data: {"type":"response.output_text.delta","delta":" two"}',
      'data: {"type":"response.completed","response":{"id":"resp-1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
      "data: [DONE]",
    ].map((line) => `${line}\n\n`).join("")), async () => {
      const session = loaded.module.createProviderPromptSession("codex");
      const result = session.getExecutor().stream(undefined, "invocation-1");
      const iterator = result.fullStream[Symbol.asyncIterator]();

      assert.equal((await iterator.next()).value.textDelta, "one");
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal((await iterator.next()).value.textDelta, " two");
      assert.equal((await iterator.next()).done, true);
      assert.equal((await result.response).messages[0].content[0].text, "one two");
    }));

    assert.deepEqual(observed, []);
  } finally {
    delete process.env.SAND_ROUTED_IDLE_TIMEOUT_MS;
    await loaded.dispose();
  }
});

test("a routed OpenRouter turn issues one provider request per attempt", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    let requests = 0;
    let refusal = null;
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(async () => {
      requests += 1;
      return new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
    }, async () => {
      await assert.rejects(
        loaded.module.runRoutedProviderText("openrouter", [{ role: "user", content: "hi" }]),
        (error) => { refusal = error; return true; },
      );
    }));

    // The SDK reports a refused request as a stream part and leaves its `response` promise
    // pending, so this used to hang rather than fail, and neither the status the provider sent nor
    // its pacing ever reached the router.
    assert.equal(loaded.classify(refusal), "provider_rate_limit");
    const paced = loaded.retryDelayMs(refusal, () => 0);
    assert.equal(paced, 2_000, `expected the provider's two second pause, got ${paced}ms`);

    // The AI SDK retries 429s and 5xx twice on its own. The router already retries routed turns,
    // and paces that retry from `Retry-After`; with both on, one rate-limited turn spent six
    // provider requests, three of them back to back inside the first attempt before any header
    // was read.
    assert.equal(requests, 1);
    assert.deepEqual(observed, []);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    await loaded.dispose();
  }
});

test("a plugin that cannot be reached dents a routed turn rather than failing it", { timeout: 30_000 }, async () => {
  const loaded = await loadProviderSession();
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const bodies = [];
    let answer = null;
    const observed = await withoutUnhandledRejections(() => withStubbedFetch(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? completion([[{ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "gmail_search", arguments: "{}" } }] }], [{}, "tool_calls"]])
        : completion([[{ content: "Gmail is not answering right now." }], [{}, "stop"]]);
    }, async () => {
      answer = await loaded.module.runRoutedProviderText("openrouter", [{ role: "user", content: "any mail?" }], {
        tools: [{ name: "gmail_search", description: "Search Gmail", inputSchema: { type: "object", properties: {} } }],
        executeTool: async () => { throw new Error("The Gmail plugin is unreachable."); },
      });
    }));

    // A rejecting tool reaches the SDK as an error part, which used to abort the turn and discard
    // the answer with it: one unplugged account cost the whole reply. The model is told the call
    // failed and gets to answer around it, which is what the other two transports already did.
    assert.equal(answer, "Gmail is not answering right now.");
    assert.equal(bodies.length, 2, "the model has to be given the failure to answer around");
    const returned = bodies[1].messages.filter((message) => message.role === "tool");
    assert.equal(returned.length, 1);
    assert.match(returned[0].content, /unreachable/);
    assert.deepEqual(observed, []);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
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
