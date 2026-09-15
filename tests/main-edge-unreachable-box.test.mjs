import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBundled(relative, name) {
  // Inside the repository, not the system temp directory: some of these modules reach a dependency
  // that is CommonJS, and the shim below can only resolve it from a path under `node_modules`.
  const temporary = await mkdtemp(path.join(repoRoot, "node_modules", `.grok-${name}-`));
  const outfile = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, relative)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function loadMainEdge() {
  return loadBundled("source/electron-main/main-edge.ts", "main-edge");
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
  let provider = "cursor";
  const stores = {
    getUserTimeZoneOverride: () => undefined,
    setUserTimeZoneOverride: () => {},
    getComputerUseModel: () => undefined,
    setComputerUseModel: () => {},
    getWebauthnProxyEnabled: () => true,
    setWebauthnProxyEnabled: () => {},
    getInferenceProvider: () => provider,
    setInferenceProvider: (next) => { provider = next; },
    getInferenceRouterUsage: () => null,
  };
  const handlers = module.createMainEdgeHandlers({
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
  return { handlers, storedProvider: () => provider };
}

test("an unreachable box leaves no unobserved rejection behind the edge's fire-and-forget syncs", async () => {
  const loaded = await loadMainEdge();
  try {
    const { handlers } = unreachableBoxHandlers(loaded.module);

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

test("a provider the box never received is not reported as the active provider", async () => {
  const loaded = await loadMainEdge();
  try {
    const { handlers, storedProvider } = unreachableBoxHandlers(loaded.module);

    // The box runs the routed turn, so swallowing the sync failure left the settings page naming
    // one provider while every turn kept going to the previous one.
    await assert.rejects(handlers.setInferenceRouter({ provider: "codex" }), /Couldn't reach the computer/);
    assert.equal(storedProvider(), "cursor");
  } finally {
    await loaded.dispose();
  }
});

test("a settings file that cannot be read does not take the window down with it", async () => {
  const wiring = await loadBundled("source/electron-main/account/cursor-auth-wiring.ts", "cursor-auth-wiring");
  const store = await loadBundled("source/shared/node/settings/sand-settings-store.ts", "sand-settings-store");
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "grok-auth-wiring-settings-"));
  try {
    // A directory where `settings.json` belongs is an unreadable file that reads as `EISDIR`, which
    // is the shape a permission or IO failure takes. The store deliberately refuses to write over
    // one — the host, the coordinator, and Electron main share that file, and one process's blip
    // must not reset every preference for all three — so the refusal arrives here, in a sync both
    // of whose callers start it and walk away. An unhandled rejection in Electron main is a crashed
    // app, so this path has to answer for the throw itself.
    const settingsPath = path.join(dataRoot, "settings.json");
    await mkdir(settingsPath, { recursive: true });
    const settingsStore = new store.module.SandSettingsStore(settingsPath);
    assert.throws(() => settingsStore.setLocalToolPermissionCeiling("read-only"), { code: "EISDIR" });

    const reported = [];
    const service = { getValidAccessToken: async () => "token" };
    const wired = wiring.module.createCursorAuthWiring({
      openExternal: () => {},
      getAccountRuntime: () => null,
      emitAuthStatus: () => {},
      sentryEnabled: false,
      fetchLocalToolPermissionCeiling: async () => "read-only",
      settingsStore,
      syncHostSettingsToBox: async () => {},
      reportFailure: (area, leg, error) => reported.push(`${area}/${leg}: ${error?.code ?? error?.message}`),
    });

    const observed = await withoutUnhandledRejections(async () => {
      wired.deliverCursorAuthStatus(service, { kind: "logged-in" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    assert.deepEqual(observed, []);
    assert.deepEqual(reported, ["host-settings/local-tool-ceiling: EISDIR"]);
  } finally {
    await wiring.dispose();
    await store.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("the webauthn mirror keeps retrying an unreachable box instead of failing the call", async () => {
  const loaded = await loadMainEdge();
  try {
    const { handlers } = unreachableBoxHandlers(loaded.module);

    // The retry loop awaited the sync without catching, so the first rejection escaped as the
    // handler's own error and the remaining attempts never ran, even though the local toggle had
    // already been applied.
    assert.equal(await handlers.setWebauthnProxyEnabled({ enabled: true }), true);
  } finally {
    await loaded.dispose();
  }
});
