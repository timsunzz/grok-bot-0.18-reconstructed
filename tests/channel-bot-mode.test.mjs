import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-channel-bot-mode-"));
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

test("channel inbound envelopes are parsed and gated before a wake is built", async () => {
  const loaded = await loadModule();
  try {
    const {
      parseChannelInboundEnvelope,
      evaluateChannelInbound,
      filterChannelInboundEnvelopes,
      channelInboundSessionKey,
      resolveChannelInboundPolicy,
    } = loaded.module;

    assert.equal(parseChannelInboundEnvelope({ sender: "Ada" }), null);
    assert.equal(parseChannelInboundEnvelope({ address: { platform: "slack", chat: "C1" }, sender: "Ada" }), null);
    const parsed = parseChannelInboundEnvelope({
      address: { platform: "slack", chat: "C1" },
      sender: "Ada",
      senderId: "U1",
      text: "hello",
      chatType: "group",
      mentionedBot: false,
      mentionedOthers: true,
      eventId: "e-1",
    });
    assert.equal(parsed?.address.chat, "C1");
    assert.equal(
      channelInboundSessionKey("agent-9", parsed),
      "agent:agent-9:slack:group:C1",
    );

    assert.deepEqual(
      evaluateChannelInbound(parsed, { requireMention: true }),
      { admit: false, reason: "require-mention" },
    );
    assert.deepEqual(
      evaluateChannelInbound({ ...parsed, mentionedBot: true }, { requireMention: true }),
      { admit: true },
    );
    assert.deepEqual(
      evaluateChannelInbound(parsed, { auth: { allowedUsers: ["U2"] } }),
      { admit: false, reason: "not-allowlisted" },
    );

    const seen = new Set();
    const filtered = filterChannelInboundEnvelopes([
      parsed,
      { ...parsed, eventId: "e-1", text: "replay" },
      { ...parsed, eventId: "e-2", text: "ok", mentionedOthers: false },
    ], {}, { seenEvent: (id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    } });
    assert.equal(filtered.admitted.length, 1);
    assert.equal(filtered.admitted[0].eventId, "e-2");
    assert.ok(filtered.rejected.some((row) => row.reason === "duplicate-event"));
    assert.ok(filtered.rejected.some((row) => row.reason === "directed-elsewhere"));

    const policy = resolveChannelInboundPolicy({
      SAND_CHANNEL_ALLOWED_USERS: "U1, U9",
      SAND_CHANNEL_REQUIRE_MENTION: "1",
    });
    assert.deepEqual(policy.auth.allowedUsers, ["U1", "U9"]);
    assert.equal(policy.requireMention, true);
  } finally {
    await loaded.dispose();
  }
});
