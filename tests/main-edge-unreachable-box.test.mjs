import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMainEdge() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-main-edge-"));
  const outfile = path.join(temporary, "main-edge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/main-edge.ts")],
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
  const record = (reason) => observed.push(reason instanceof Error ? reason.message : String(reason));
  process.on("unhandledRejection", record);
  try {
    await run();
    // Rejections are reported on a later turn of the event loop than the throw that caused them.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    process.off("unhandledRejection", record);
  }
  return observed;
}

function unreachableBoxHandlers(module) {
  const unreachable = async () => { throw new Error("gateway unreachable"); };
  const stores = {
    getUserTimeZoneOverride: () => undefined,
    setUserTimeZoneOverride: () => {},
    getComputerUseModel: () => undefined,
    setComputerUseModel: () => {},
    getWebauthnProxyEnabled: () => true,
    setWebauthnProxyEnabled: () => {},
  };
  return module.createMainEdgeHandlers({
    readLiveUpdateService: () => null,
    readThemeController: () => null,
    readEgressTunnelController: () => null,
    settingsStore: stores,
    agentPrefsStore: stores,
    boxToggleStore: stores,
    onboardingSeen: { apply: unreachable },
    shell: {},
    boxRecovery: {},
    windowChrome: {},
    avatarImages: {},
    attachments: {},
    cursorAccount: {},
    experiments: {},
    syncHostSettingsToBox: unreachable,
    readHostSettingsFromBox: unreachable,
    recordLocalToolApproval: async () => {},
    clearLocalToolApprovals: async () => {},
    getComputerUseModelOverride: () => undefined,
    fetchAvailableModels: () => [],
    emitEgressTunnelChanged: () => {},
    emitWebauthnProxyChanged: () => {},
    ensureTranscriptionManager: async () => ({}),
    platform: "darwin",
    detectTimeZone: () => "UTC",
    delay: async () => {},
  });
}

test("an unreachable box leaves no unobserved rejection behind the edge's fire-and-forget syncs", async () => {
  const loaded = await loadMainEdge();
  try {
    const handlers = unreachableBoxHandlers(loaded.module);

    // These handlers answer the renderer from local state and push to the box without awaiting,
    // so a rejection had no handler at all. Node treats that as fatal by default, which means a
    // box that is merely reconnecting could take the whole window down.
    const observed = await withoutUnhandledRejections(async () => {
      await handlers.setTimeZoneOverride({ timeZone: "Europe/Berlin" });
      await handlers.setComputerUseModel({ model: { modelId: "m", maxMode: false, parameters: [] } });
      await handlers.setOnboardingSeen({ seen: true });
    });

    assert.deepEqual(observed, []);
  } finally {
    await loaded.dispose();
  }
});

test("the webauthn mirror keeps retrying an unreachable box instead of failing the call", async () => {
  const loaded = await loadMainEdge();
  try {
    const handlers = unreachableBoxHandlers(loaded.module);

    // The retry loop awaited the sync without catching, so the first rejection escaped as the
    // handler's own error and the remaining attempts never ran, even though the local toggle had
    // already been applied.
    assert.equal(await handlers.setWebauthnProxyEnabled({ enabled: true }), true);
  } finally {
    await loaded.dispose();
  }
});
