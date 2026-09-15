import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-agent-inbound-"));
  const output = path.join(temporary, "agent-to-agent-messaging.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/transcript/agent-to-agent-messaging.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("failed A2A session resolve puts the inbound batch back on the queue", async () => {
  const loaded = await loadModule();
  try {
    const tm = {
      execution: { canExecute: true },
      sessions: {
        isAgentGone: () => false,
        liveSessions: new Map(),
        resolveBackgroundSession: async () => { throw new Error("box offline"); },
      },
      groupChat: {
        isRemoteRoomAgentId: () => false,
        isGroupSession: () => false,
        isRemoteRoomSession: () => false,
      },
      sessionStore: { listAgents: async () => [] },
      productAnalytics: { trackEvent() {} },
    };
    const messaging = new loaded.module.AgentToAgentMessaging(tm);
    const inbound = [{ from: { id: "a", name: "A" }, text: "hi", timestampMs: 1 }];
    messaging.pendingAgentInbound.set("b", inbound);
    await messaging.reviveForAgentInbound("b");
    assert.equal(messaging.pendingAgentInbound.get("b")?.length, 1);
    assert.equal(messaging.pendingAgentInbound.get("b")?.[0].text, "hi");
  } finally {
    await loaded.dispose();
  }
});
