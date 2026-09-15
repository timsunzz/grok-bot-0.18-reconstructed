import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadStore() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-settings-store-"));
  const outfile = path.join(temporary, "sand-settings-store.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("settings that could not be read are preserved instead of overwritten", async () => {
  const loaded = await loadStore();
  try {
    const settingsPath = path.join(loaded.temporary, "state", "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);

    store.setInferenceProvider("codex");
    assert.equal(store.getInferenceProvider(), "codex");

    // A truncated file is what a crash mid-write or a partially synced data directory leaves
    // behind. Reading it fails, so the next write used to persist defaults over the top and
    // silently destroy every stored preference.
    await writeFile(settingsPath, '{"version":1,"inferenceProvider":"cod');
    store.setThemePreference("dark");

    const quarantined = (await readdir(path.dirname(settingsPath))).filter((name) => name.includes(".unreadable-"));
    assert.equal(quarantined.length, 1, "the unreadable file should be kept for recovery");
    assert.equal(await readFile(path.join(path.dirname(settingsPath), quarantined[0]), "utf8"), '{"version":1,"inferenceProvider":"cod');
  } finally {
    await loaded.dispose();
  }
});

test("settings written by an unknown schema version are preserved", async () => {
  const loaded = await loadStore();
  try {
    const settingsPath = path.join(loaded.temporary, "state", "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);
    store.setInferenceProvider("codex");

    // A downgrade sees a version it cannot parse. Resetting to defaults is a reasonable read,
    // but destroying the newer file is not: it is the only copy of the user's preferences.
    await writeFile(settingsPath, JSON.stringify({ version: 99, inferenceProvider: "openrouter" }));
    assert.equal(store.getInferenceProvider(), "cursor");
    store.setInferenceProvider("claude-code");

    const quarantined = (await readdir(path.dirname(settingsPath))).filter((name) => name.includes(".unreadable-"));
    assert.equal(quarantined.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(path.dirname(settingsPath), quarantined[0]), "utf8")).version, 99);
    assert.equal(store.getInferenceProvider(), "claude-code");
  } finally {
    await loaded.dispose();
  }
});

test("a missing settings file is a fresh start, not a recovery", async () => {
  const loaded = await loadStore();
  try {
    const settingsPath = path.join(loaded.temporary, "state", "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);

    assert.equal(store.getInferenceProvider(), "cursor");
    store.setInferenceProvider("openrouter");

    assert.deepEqual((await readdir(path.dirname(settingsPath))).filter((name) => name !== "settings.json"), []);
    assert.equal(store.getInferenceProvider(), "openrouter");
  } finally {
    await loaded.dispose();
  }
});

test("persisting leaves no temporary file behind and keeps the file private", async () => {
  const loaded = await loadStore();
  try {
    const settingsPath = path.join(loaded.temporary, "state", "settings.json");
    const store = new loaded.module.SandSettingsStore(settingsPath);
    store.setInferenceProvider("codex");
    store.recordInferenceUsage("codex", { inputTokens: 10, outputTokens: 4 });

    assert.deepEqual(await readdir(path.dirname(settingsPath)), ["settings.json"]);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    assert.equal(store.getInferenceRouterUsage().providers.codex.inputTokens, 10);
  } finally {
    await loaded.dispose();
  }
});
