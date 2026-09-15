import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
    let scheduledRetries = 0;
    messaging.scheduleAgentInboundRetry = () => {
      scheduledRetries += 1;
    };

    await messaging.reviveForAgentInbound("recipient");

    assert.deepEqual(messaging.pendingAgentInbound.get("recipient"), [message]);
    assert.equal(messaging.revivingAgentInboundIds.has("recipient"), false);
    assert.equal(scheduledRetries, 1);
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
    messaging.scheduleAgentInboundRetry = () => {};

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

test("an enqueue failure requeues the message and balances run lifecycle state", async () => {
  const loaded = await loadModule();
  try {
    const lifecycle = { began: 0, ended: 0 };
    const session = { id: "recipient" };
    const messaging = new loaded.module.AgentToAgentMessaging({
      execution: { canExecute: true },
      sessions: {
        resolveBackgroundSession: async () => session,
        isAgentGone: () => false,
      },
      groupChat: {
        isGroupSession: () => false,
        isRemoteRoomSession: () => false,
      },
      runnerRegistry: { getRunner: () => ({}) },
      runLifecycle: {
        beginSessionRun: () => {
          lifecycle.began += 1;
        },
        endSessionRun: () => {
          lifecycle.ended += 1;
        },
        enqueueExclusiveRun: async () => {
          throw new Error("scheduler unavailable");
        },
      },
    });
    const message = {
      from: { id: "sender", name: "Sender" },
      text: "retry me",
      timestampMs: 1,
    };
    messaging.pendingAgentInbound.set("recipient", [message]);
    messaging.scheduleAgentInboundRetry = () => {};

    await messaging.reviveForAgentInbound("recipient");

    assert.deepEqual(messaging.pendingAgentInbound.get("recipient"), [message]);
    assert.deepEqual(lifecycle, { began: 1, ended: 1 });
  } finally {
    await loaded.dispose();
  }
});

test("priority messages arriving before dispatch run ahead of the claimed batch", async () => {
  const loaded = await loadModule();
  try {
    let releaseDispatch;
    const dispatchGate = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    const lifecycle = { began: 0, ended: 0 };
    const session = { id: "recipient" };
    const messaging = new loaded.module.AgentToAgentMessaging({
      execution: { canExecute: true },
      sessions: { resolveBackgroundSession: async () => session },
      groupChat: {
        isGroupSession: () => false,
        isRemoteRoomSession: () => false,
      },
      runnerRegistry: { getRunner: () => ({}) },
      runLifecycle: {
        beginSessionRun: () => {
          lifecycle.began += 1;
        },
        endSessionRun: () => {
          lifecycle.ended += 1;
        },
        enqueueExclusiveRun: async (_id, run) => {
          await dispatchGate;
          await run();
        },
      },
    });
    const older = {
      from: { id: "sender", name: "Sender" },
      text: "older",
      timestampMs: 1,
    };
    const priority = {
      from: { id: "sender", name: "Sender" },
      text: "urgent",
      timestampMs: 2,
      priority: true,
    };

    const dispatch = messaging.runAgentInboundWake("recipient", [older]);
    messaging.pendingAgentInbound.set("recipient", [priority]);
    releaseDispatch();
    assert.equal(await dispatch, true);

    assert.deepEqual(messaging.pendingAgentInbound.get("recipient"), [
      priority,
      older,
    ]);
    assert.deepEqual(lifecycle, { began: 1, ended: 1 });
  } finally {
    await loaded.dispose();
  }
});

test("a rejected transcript append does not mark the message as displayed", async () => {
  const loaded = await loadModule();
  try {
    const messaging = new loaded.module.AgentToAgentMessaging({
      sessions: { activeSession: undefined },
      sessionStore: { markSessionActivity: () => {} },
      roster: { emitAgentUpdate: () => {} },
    });
    const message = {
      from: { id: "sender", name: "Sender" },
      text: "persist me",
      timestampMs: 1,
    };
    const session = {
      id: "recipient",
      db: {
        addConversationPartner: () => {},
        getTranscriptEntries: () => [],
        appendTranscriptEntry: () => false,
      },
    };

    assert.throws(
      () => messaging.appendAgentInboundEntries(session, [message]),
      /Failed to persist/,
    );
    assert.notEqual(message.isDisplayed, true);

    const activeMessage = { ...message, text: "persist active" };
    let emitted = false;
    const activeMessaging = new loaded.module.AgentToAgentMessaging({
      sessions: { activeSession: session },
      sessionStore: { markSessionActivity: () => {} },
      roster: {
        emit: () => {
          emitted = true;
        },
        emitAgentUpdate: () => {},
      },
      appendEntry: (_entry, options) => {
        options.onPersistOutcome(false);
      },
    });
    assert.throws(
      () => activeMessaging.appendAgentInboundEntries(session, [activeMessage]),
      /Failed to persist/,
    );
    assert.notEqual(activeMessage.isDisplayed, true);
    assert.equal(emitted, false);
  } finally {
    await loaded.dispose();
  }
});

test("a queued message keeps retrying while execution is temporarily disabled", async () => {
  const loaded = await loadModule();
  try {
    const execution = { canExecute: false };
    const messaging = new loaded.module.AgentToAgentMessaging(
      {
        execution,
        sessions: { isAgentGone: () => false },
      },
      0,
    );
    const message = {
      from: { id: "sender", name: "Sender" },
      text: "wake later",
      timestampMs: 1,
    };
    messaging.pendingAgentInbound.set("recipient", [message]);
    messaging.runAgentInboundWake = async () => true;

    await messaging.reviveForAgentInbound("recipient");
    assert.equal(messaging.retryingAgentInboundIds.has("recipient"), true);
    execution.canExecute = true;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(messaging.pendingAgentInbound.has("recipient"), false);
    assert.equal(messaging.retryingAgentInboundIds.has("recipient"), false);
  } finally {
    await loaded.dispose();
  }
});
