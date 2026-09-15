import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-settings-persist-"));
  const output = path.join(temporary, "sand-settings-store.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("settings persist writes a private file through a unique temporary name", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-settings-data-"));
  try {
    const settingsPath = path.join(dataDir, "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);
    store.setInferenceProvider("openrouter");
    const info = await stat(settingsPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(store.getInferenceProvider(), "openrouter");
    const source = await readFile(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts"), "utf8");
    assert.match(source, /randomUUID\(\)/);
    assert.match(source, /mode: 0o600/);
    assert.match(source, /settings migration persist failed/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});
