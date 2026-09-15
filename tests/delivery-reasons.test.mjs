import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-delivery-reasons-"));
  const output = path.join(temporary, "delivery-reasons.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/delivery-reasons.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("delivery reasons classify channel, agent, and provider failures", async () => {
  const loaded = await loadModule();
  try {
    const {
      classifyChannelDeliveryFailure,
      classifyAgentSendFailure,
      classifyErrorForDelivery,
      formatDeliveryNotice,
      parseDeliveryNotice,
      shouldAutoRetryDelivery,
    } = loaded.module;
    assert.equal(classifyChannelDeliveryFailure("slack:C1", "No channel delivery mechanism is registered."), "missing_config");
    assert.equal(classifyChannelDeliveryFailure("slack:C1", "429 rate limit"), "provider_rate_limit");
    assert.equal(classifyAgentSendFailure("gone"), "missing_config");
    assert.equal(classifyErrorForDelivery(new Error("401 Unauthorized")), "provider_auth_or_access");
    assert.equal(classifyErrorForDelivery(new Error("context window overflow")), "context_overflow");
    assert.equal(shouldAutoRetryDelivery("provider_server_error", 0), true);
    assert.equal(shouldAutoRetryDelivery("provider_server_error", 1), false);
    assert.equal(shouldAutoRetryDelivery("provider_auth_or_access", 0), false);
    assert.deepEqual(parseDeliveryNotice(formatDeliveryNotice("target_busy", "wait")), {
      reason: "target_busy",
      text: "wait",
    });
  } finally {
    await loaded.dispose();
  }
});
