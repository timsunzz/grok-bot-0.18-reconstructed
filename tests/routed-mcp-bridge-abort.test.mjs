import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBridge() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-bridge-"));
  const outfile = path.join(temporary, "routed-mcp-bridge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-mcp-bridge.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function withoutUnhandledRejections(run) {
  const observed = [];
  const record = (reason) => observed.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  process.on("unhandledRejection", record);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    process.off("unhandledRejection", record);
  }
  return observed;
}

function request(url, { body, announcedLength, abortAfterMs }) {
  const target = new URL(url);
  return new Promise((resolve) => {
    let received = "";
    const socket = connect(Number(target.port), "127.0.0.1", () => {
      // Without `close`, keep-alive holds the socket open until the server's idle timeout and the
      // test waits seconds for a response it already has.
      socket.write(`POST ${target.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${announcedLength ?? Buffer.byteLength(body)}\r\n\r\n`);
      socket.write(body);
      if (abortAfterMs != null) setTimeout(() => { socket.destroy(); resolve(received); }, abortAfterMs);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.once("close", () => resolve(received));
    socket.once("error", () => resolve(received));
  });
}

test("a client that vanishes mid-upload does not take the coordinator with it", { timeout: 30_000 }, async () => {
  const loaded = await loadBridge();
  let bridge;
  try {
    bridge = await loaded.module.createRoutedMcpBridge({ listTools: async () => [], callTool: async () => ({}) });

    const observed = await withoutUnhandledRejections(async () => {
      // The request iterator rejects with `Error: aborted`, and the coordinator exits on
      // `unhandledRejection`, so one abandoned tool call used to kill the whole process.
      await request(bridge.url, {
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"',
        announcedLength: 5_000,
        abortAfterMs: 100,
      });
    });

    assert.deepEqual(observed, []);

    // The bridge is still serving afterwards, which is the point of surviving the abort.
    const answered = await request(bridge.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) });
    assert.match(answered, /"serverInfo"/);
  } finally {
    await bridge?.close();
    await loaded.dispose();
  }
});

test("an oversized body is refused without reading the rest of it", { timeout: 30_000 }, async () => {
  const loaded = await loadBridge();
  let bridge;
  try {
    bridge = await loaded.module.createRoutedMcpBridge({ listTools: async () => [], callTool: async () => ({}) });

    const observed = await withoutUnhandledRejections(async () => {
      // Announces eight megabytes and sends only the first one. A bridge that waited for the body
      // it was promised before refusing it would never answer this at all, and the sender would
      // keep filling a socket whose request nobody is reading.
      const answered = await request(bridge.url, {
        body: `{"padding":"${"x".repeat(1_100_000)}"}`,
        announcedLength: 8_000_000,
      });
      assert.match(answered, /^HTTP\/1\.1 413/);
    });

    assert.deepEqual(observed, []);

    const stillServing = await request(bridge.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) });
    assert.match(stillServing, /"serverInfo"/);
  } finally {
    await bridge?.close();
    await loaded.dispose();
  }
});

test("a failing tool call answers the caller instead of rejecting", { timeout: 30_000 }, async () => {
  const loaded = await loadBridge();
  let bridge;
  try {
    bridge = await loaded.module.createRoutedMcpBridge({
      listTools: async () => [{ name: "gmail_search", providerIdentifier: "gmail", toolName: "search" }],
      callTool: async () => { throw new Error("the provider is not reachable"); },
    });

    const observed = await withoutUnhandledRejections(async () => {
      await request(bridge.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const answered = await request(bridge.url, {
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gmail_search", arguments: {} } }),
      });
      assert.match(answered, /the provider is not reachable/);
      assert.match(answered, /"isError":true/);
    });

    assert.deepEqual(observed, []);
  } finally {
    await bridge?.close();
    await loaded.dispose();
  }
});
