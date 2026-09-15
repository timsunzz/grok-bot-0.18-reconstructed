import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `grok-host-settings-${name}-`));
  const outfile = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dir: temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("host settings parsers reject a malformed field instead of salvaging part of it", async () => {
  const loaded = await load("source/shared/host-settings-input.ts", "input");
  try {
    const { parseAgentIdList, parseSidebarSectionList } = loaded.module;

    // A bare string is iterable, so spreading it into the store used to persist one agent id per
    // character.
    assert.equal(parseAgentIdList("abc"), null);
    assert.equal(parseAgentIdList(5), null);
    assert.equal(parseAgentIdList(null), null);
    assert.equal(parseAgentIdList(["ok", 7]), null);
    assert.deepEqual(parseAgentIdList([]), []);
    assert.deepEqual(parseAgentIdList([" a ", "a", "", "b"]), ["a", "b"]);

    assert.equal(parseSidebarSectionList({ id: "x" }), null);
    assert.equal(parseSidebarSectionList([{ nope: true }]), null);
    assert.equal(parseSidebarSectionList([{ id: "s", name: "n", agentIds: [{ deep: 1 }] }]), null);
    assert.equal(parseSidebarSectionList([{ id: "s", name: "n", agentIds: [], isCollapsed: "yes" }]), null);
    assert.deepEqual(
      parseSidebarSectionList([{ id: "s", name: "n", agentIds: ["a"], isCollapsed: true }]),
      [{ id: "s", name: "n", agentIds: ["a"], isCollapsed: true }],
    );
  } finally {
    await loaded.dispose();
  }
});

test("a malformed field no longer abandons the rest of a host settings batch", async () => {
  const loaded = await load("source/host/extensions/settings/settings-service.ts", "settings-service");
  try {
    const settingsPath = path.join(loaded.dir, "settings.json");
    const service = new loaded.module.SettingsService(settingsPath);
    service.setHostSettings({ pinnedAgentIds: ["keep-me"] });

    // `setPinnedAgentIds` spread its argument, so a non-iterable threw from inside the store and
    // every later field in the same update — here the provider choice — silently never landed.
    service.setHostSettings({ pinnedAgentIds: 5, hasSeenOnboarding: true, inferenceProvider: "codex" });
    const settings = service.getHostSettings();
    assert.equal(settings.inferenceProvider, "codex");
    assert.equal(settings.hasSeenOnboarding, true);
    assert.deepEqual(settings.pinnedAgentIds, ["keep-me"]);

    service.setHostSettings({ pinnedAgentIds: "abc" });
    assert.deepEqual(service.getHostSettings().pinnedAgentIds, ["keep-me"]);

    // Sections used to reach `SidebarSections.normalize`, which calls `.trim()` on every id.
    service.setHostSettings({ sidebarSections: [{ nope: true }] });
    service.setHostSettings({ sidebarSections: { id: "x" } });
    service.setHostSettings({ sidebarSections: [{ id: "s", name: "n", agentIds: [{ deep: 1 }] }] });
    assert.deepEqual(service.getHostSettings().sidebarSections, []);

    service.setHostSettings({ sidebarSections: [{ id: "s", name: "Work", agentIds: ["a"], isCollapsed: true }] });
    assert.deepEqual(service.getHostSettings().sidebarSections, [
      { id: "s", name: "Work", agentIds: ["a"], isCollapsed: true },
      { id: "__agents__", name: "Unassigned", agentIds: [], isCollapsed: false },
    ]);

    // Nothing that was rejected may reach disk.
    const stored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(stored.pinnedAgentIds, ["keep-me"]);
    assert.deepEqual(stored.sidebarSections.map((section) => section.agentIds), [["a"], []]);
  } finally {
    await loaded.dispose();
  }
});

function edgeHarness(module) {
  const writes = [];
  const stores = {
    getUserTimeZoneOverride: () => undefined,
    setUserTimeZoneOverride: () => {},
    getComputerUseModel: () => undefined,
    setComputerUseModel: () => {},
    getInferenceProvider: () => "cursor",
    getInferenceRouterUsage: () => null,
  };
  const handlers = module.createMainEdgeHandlers({
    readLiveUpdateService: () => null,
    readThemeController: () => null,
    readEgressTunnelController: () => null,
    settingsStore: stores,
    agentPrefsStore: stores,
    boxToggleStore: {},
    onboardingSeen: {},
    shell: {},
    boxRecovery: {},
    windowChrome: {},
    avatarImages: {},
    attachments: {},
    cursorAccount: {},
    experiments: {},
    syncHostSettingsToBox: async (settings) => { writes.push(settings); return settings; },
    readHostSettingsFromBox: async () => ({ pinnedAgentIds: ["stored"], sidebarSections: [] }),
    recordLocalToolApproval: async () => {},
    clearLocalToolApprovals: async () => {},
    getComputerUseModelOverride: () => undefined,
    fetchAvailableModels: () => [],
    emitEgressTunnelChanged: () => {},
    emitWebauthnProxyChanged: () => {},
    ensureTranscriptionManager: async () => ({}),
    platform: "darwin",
    detectTimeZone: () => "UTC",
  });
  return { handlers, writes };
}

test("the Electron edge refuses malformed sidebar and pinned-agent payloads", async () => {
  const loaded = await load("source/electron-main/main-edge.ts", "main-edge");
  try {
    const { handlers, writes } = edgeHarness(loaded.module);

    assert.deepEqual(await handlers.setHostPinnedAgents({ pinnedAgentIds: "abc" }), ["stored"]);
    assert.deepEqual(await handlers.setHostSidebarSections({ sections: [{ nope: true }] }), []);
    assert.deepEqual(writes, []);

    assert.deepEqual(await handlers.setHostPinnedAgents({ pinnedAgentIds: ["a", "a", " b "] }), ["a", "b"]);
    assert.deepEqual(writes, [{ pinnedAgentIds: ["a", "b"] }]);
  } finally {
    await loaded.dispose();
  }
});
