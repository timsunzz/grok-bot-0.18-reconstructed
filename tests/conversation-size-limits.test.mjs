import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-conversation-limits-"));
  const output = path.join(temporary, "conversation-size-limits.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/session/conversation-size-limits.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("hard conversation cap refuses the turn when GC fails or is skipped", async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-conversation-hard-"));
  const previousHard = process.env.SAND_CONVERSATION_HARD_LIMIT_BYTES;
  const previousGc = process.env.SAND_CONVERSATION_GC;
  try {
    process.env.SAND_CONVERSATION_HARD_LIMIT_BYTES = "32";
    process.env.SAND_CONVERSATION_GC = "1";
    loaded.module.pinConversationGc(true);
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const dbPath = path.join(agentDir, "store.db");
    await writeFile(path.join(agentDir, "conversation-blobs.db"), "x".repeat(64));
    await assert.rejects(
      () => loaded.module.ensureConversationCapacityForTurn({
        requireWorkerPool: () => ({
          collectConversationGarbage: async () => ({ outcome: "skipped", reason: "busy" }),
        }),
      }, dbPath, { get: () => new Uint8Array([1]) }),
      (error) => error instanceof loaded.module.SandConversationTooLargeError,
    );
    await assert.rejects(
      () => loaded.module.ensureConversationCapacityForTurn({
        requireWorkerPool: () => ({
          collectConversationGarbage: async () => { throw new Error("gc exploded"); },
        }),
      }, dbPath, { get: () => new Uint8Array([1]) }),
      (error) => error instanceof loaded.module.SandConversationTooLargeError,
    );
  } finally {
    if (previousHard === undefined) delete process.env.SAND_CONVERSATION_HARD_LIMIT_BYTES;
    else process.env.SAND_CONVERSATION_HARD_LIMIT_BYTES = previousHard;
    if (previousGc === undefined) delete process.env.SAND_CONVERSATION_GC;
    else process.env.SAND_CONVERSATION_GC = previousGc;
    loaded.module.pinConversationGc(false);
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
