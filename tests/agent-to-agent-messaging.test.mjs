import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "grok-agent-messaging-"),
  );
  const output = path.join(temporary, "agent-to-agent-messaging.mjs");
  await build({
    entryPoints: [
      path.join(
        repoRoot,
        "source/host/extensions/transcript/agent-to-agent-messaging.ts",
      ),
    ],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return {
    module,
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

test("agent messages remain queued when the target session is temporarily unavailable", async () => {
  const loaded = await loadModule();
  try {
    const messaging = new loaded.module.AgentToAgentMessaging({
      execution: { canExecute: true },
      sessions: {
        resolveBackgroundSession: async () => {
          throw new Error("temporary session open failure");
        },
      },
    });
    const message = {
      from: { id: "sender", name: "Sender" },
      text: "Please investigate",
      timestampMs: 123,
    };
    messaging.pendingAgentInbound.set("recipient", [message]);

    await messaging.reviveForAgentInbound("recipient");

    assert.deepEqual(messaging.pendingAgentInbound.get("recipient"), [message]);
    assert.equal(messaging.revivingAgentInboundIds.has("recipient"), false);
  } finally {
    await loaded.dispose();
  }
});

test("a failed revival preserves priority ordering without dropping newer messages", async () => {
  const loaded = await loadModule();
  try {
    let releaseSession;
    const sessionAttempt = new Promise((resolve) => {
      releaseSession = resolve;
    });
    const messaging = new loaded.module.AgentToAgentMessaging({
      execution: { canExecute: true },
      sessions: {
        resolveBackgroundSession: async () => {
          await sessionAttempt;
          throw new Error("temporary session open failure");
        },
      },
    });
    const older = {
      from: { id: "sender", name: "Sender" },
      text: "older",
      timestampMs: 1,
    };
    const newerPriority = {
      from: { id: "sender", name: "Sender" },
      text: "new priority",
      timestampMs: 2,
      priority: true,
    };
    messaging.pendingAgentInbound.set("recipient", [older]);

    const revival = messaging.reviveForAgentInbound("recipient");
    await Promise.resolve();
    messaging.pendingAgentInbound.set("recipient", [newerPriority]);
    releaseSession();
    await revival;

    assert.deepEqual(messaging.pendingAgentInbound.get("recipient"), [
      newerPriority,
      older,
    ]);
  } finally {
    await loaded.dispose();
  }
});
