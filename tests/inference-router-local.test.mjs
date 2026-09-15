import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadLocal() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-local-"));
  const output = path.join(temporary, "local.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/node/inference-router-local.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("local CLI resolution ignores directories and non-executable files", async () => {
  const loaded = await loadLocal();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-cli-"));
  try {
    const directory = path.join(root, "codex");
    const file = path.join(root, "claude");
    await mkdir(directory);
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o644);
    assert.equal(loaded.module.isUsableExecutable(directory), false);
    assert.equal(loaded.module.isUsableExecutable(file), false);
    await chmod(file, 0o755);
    assert.equal(loaded.module.isUsableExecutable(file), true);
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
