import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBridge() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-bridge-"));
  const output = path.join(temporary, "bridge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-mcp-bridge.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function rpc(url, method, params, id = 1) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: response.status, body: await response.json() };
}

test("routed MCP bridge discovers tools on first call and blocks repeated identical calls", async () => {
  const loaded = await loadBridge();
  const calls = [];
  const bridge = await loaded.module.createRoutedMcpBridge({
    listTools: async () => [{
      name: "gmail_search",
      providerIdentifier: "user-Gmail",
      toolName: "search_threads",
      description: "Search mail",
      inputSchema: { type: "object" },
    }],
    callTool: async args => {
      calls.push(args);
      return { result: { case: "success", value: { content: [{ content: { case: "text", value: { text: "ok" } } }] } } };
    },
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      const allowed = await rpc(bridge.url, "tools/call", { name: "gmail_search", arguments: { query: "inbox" } });
      assert.equal(allowed.body.result.isError, false);
    }
    const blocked = await rpc(bridge.url, "tools/call", { name: "gmail_search", arguments: { query: "inbox" } });
    assert.equal(blocked.body.result.isError, true);
    assert.match(blocked.body.result.content[0].text, /Tool loop guard/);
    assert.equal(calls.length, 3);

    const unknown = await rpc(bridge.url, "missing", {});
    assert.equal(unknown.body.error.code, -32601);
  } finally {
    await bridge.close();
    await loaded.dispose();
  }
});
