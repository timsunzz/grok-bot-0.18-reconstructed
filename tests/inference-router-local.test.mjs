import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-local-"));
  const output = path.join(temporary, "inference-router-local.mjs");
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

test("Codex auth.json with default 0644 is repaired to a private regular file", async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-codex-auth-"));
  try {
    const authPath = path.join(root, "auth.json");
    await writeFile(authPath, JSON.stringify({ ok: true }), { mode: 0o644 });
    assert.equal(loaded.module.resolvePrivateRegularFile(authPath), authPath);
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("directories named like CLIs are not treated as executables", async () => {
  const loaded = await loadModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-cli-dir-"));
  try {
    const directory = path.join(root, "claude");
    await chmod(root, 0o755);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory);
    const previous = process.env.PATH;
    process.env.PATH = root;
    try {
      assert.equal(loaded.module.resolveClaudeCodeCliPath(), null);
    } finally {
      process.env.PATH = previous;
    }
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
