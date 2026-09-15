import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-bridge-"));
  const output = path.join(temporary, "routed-mcp-bridge.mjs");
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

test("routed MCP arguments accept JSON strings and keep a stable tool call id", async () => {
  const loaded = await loadModule();
  try {
    assert.deepEqual(loaded.module.parseRoutedToolArguments("{\"query\":\"in:inbox\"}"), { query: "in:inbox" });
    assert.throws(() => loaded.module.parseRoutedToolArguments(["nope"]));
    const first = loaded.module.routedToolCallId(null, "gmail_search", { query: "x" });
    const second = loaded.module.routedToolCallId(null, "gmail_search", { query: "x" });
    assert.equal(first, second);
    assert.equal(loaded.module.routedToolCallId({ toolCallId: "call-1" }, "gmail_search", {}), "call-1");
  } finally {
    await loaded.dispose();
  }
});
