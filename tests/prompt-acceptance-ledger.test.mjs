import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-acceptance-ledger-"));
  const output = path.join(temporary, "prompt-acceptance-ledger.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/prompt-acceptance-ledger.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("damaged acceptance ledger refuses dispatch instead of duplicating the send", async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acceptance-root-"));
  try {
    await writeFile(path.join(root, loaded.module.SAND_SEND_ACCEPTANCE_FILE_NAME), "{not-json", "utf8");
    const ledger = new loaded.module.PromptAcceptanceLedger(root, () => 1);
    assert.equal(ledger.lookup({ accountSlot: "host", clientNonce: "n1" }).outcome, "unknown-durability");
    assert.throws(
      () => ledger.admitSend({ accountSlot: "host", clientNonce: "n1", inputDigest: "abc" }),
      (error) => error instanceof loaded.module.PromptAcceptanceUnknownDurabilityError,
    );
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown nonce still dispatches when the ledger is healthy", async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acceptance-healthy-"));
  try {
    const ledger = new loaded.module.PromptAcceptanceLedger(root, () => 1);
    assert.deepEqual(
      ledger.admitSend({ accountSlot: "host", clientNonce: "fresh", inputDigest: "abc" }),
      { kind: "dispatch" },
    );
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
