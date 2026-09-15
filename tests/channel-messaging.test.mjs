import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-channel-messaging-"));
  const output = path.join(temporary, "channel-messaging.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/channel-messaging.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("channel delivery failures carry typed reason codes", async () => {
  const loaded = await loadModule();
  try {
    const text = loaded.module.humanizeChannelDeliveryFailure(
      "slack:C123",
      "No channel delivery mechanism is registered.",
    );
    assert.match(text, /^\[reason:missing_config\]/);
    const wake = loaded.module.buildChannelDeliveryFailureWakePrompt([
      { addressToken: "slack:C123", reason: text },
    ]);
    assert.match(wake, /Do not retry \[reason:provider_auth_or_access\]/);
    assert.match(wake, /single automatic retry/);
  } finally {
    await loaded.dispose();
  }
});
