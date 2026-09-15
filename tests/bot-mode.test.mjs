import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = mkdtempSync(path.join(tmpdir(), "grok-bot-mode-"));
  const output = path.join(temporary, "mod.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

test("bot roster upserts unique slugs and rejects the default name", async () => {
  const { emptyBotRoster, upsertBot, slugifyBotName, findBot, deleteBot, hideBot, parseBotRoster } = await load("source/shared/bot-mode/index.ts");
  assert.equal(slugifyBotName("Research Buddy"), "research-buddy");
  let roster = emptyBotRoster();
  roster = upsertBot(roster, { name: "Research Buddy", title: "Researcher", description: "Read first." }, "2026-01-01T00:00:00.000Z");
  assert.equal(roster.bots[0].slug, "research-buddy");
  assert.equal(findBot(roster, "@ResearchBuddy")?.name, "Research Buddy");
  assert.throws(() => upsertBot(roster, { name: "research-buddy" }), /already taken/);
  assert.throws(() => upsertBot(roster, { name: "New Bot" }), /real name/);
  roster = hideBot(roster, roster.bots[0].id, true);
  assert.equal(roster.bots[0].hidden, true);
  roster = deleteBot(roster, roster.bots[0].id);
  assert.equal(roster.bots.length, 0);
  assert.deepEqual(parseBotRoster({ schemaVersion: 1, bots: [{ id: "bad" }] }).bots, []);
});

test("mentions skip email addresses and resolve live roster handles", async () => {
  const { emptyBotRoster, upsertBot, extractMentionHandles, resolveMentions, unknownMentions, findBot } = await load("source/shared/bot-mode/index.ts");
  const roster = upsertBot(emptyBotRoster(), { id: "bot-research", name: "Research Buddy" });
  assert.deepEqual(extractMentionHandles("ask @research-buddy, not user@example.com"), ["research-buddy"]);
  assert.equal(resolveMentions("please @Research-Buddy review this", roster)[0].bot.id, "bot-research");
  assert.deepEqual(unknownMentions("ping @missing", roster), ["missing"]);
  assert.equal(findBot(roster, "@bot-research")?.id, "bot-research");
  assert.equal(findBot(roster, "BOT-RESEARCH")?.id, "bot-research");
});

test("message_agent validates targets and classifies retryable failures", async () => {
  const {
    emptyBotRoster,
    upsertBot,
    validateMessageAgent,
    attributedBotMessage,
    stripSilenceToken,
    classifyBotFailure,
    isTransientBotFailure,
    formatBotFailure,
    parseBotFailureTag,
  } = await load("source/shared/bot-mode/index.ts");
  let roster = upsertBot(emptyBotRoster(), { id: "bot-a", name: "Alpha" });
  roster = upsertBot(roster, { id: "bot-b", name: "Beta" });
  assert.equal(validateMessageAgent(roster, "bot-a", { target: "beta", message: "hello" }).ok, true);
  assert.equal(validateMessageAgent(roster, "bot-a", { target: "alpha", message: "hello" }).ok, false);
  assert.match(attributedBotMessage({ name: "Alpha", slug: "alpha" }, "hello"), /@alpha/);
  assert.equal(stripSilenceToken("[SILENT]").silent, true);
  assert.equal(classifyBotFailure(new Error("429 rate limit")), "provider_rate_limit");
  assert.equal(classifyBotFailure(new Error("401 unauthorized")), "provider_auth_or_access");
  assert.equal(isTransientBotFailure("provider_rate_limit"), true);
  assert.equal(isTransientBotFailure("provider_auth_or_access"), false);
  assert.deepEqual(parseBotFailureTag(formatBotFailure("provider_quota_limit", "out of credits")), {
    reason: "provider_quota_limit",
    message: "out of credits",
  });
});

test("group rounds cap speakers and settle after a silent pass", async () => {
  const { emptyBotRoster, upsertBot, createBotGroup, planGroupRound, nextGroupRound, parseUserMentions } = await load("source/shared/bot-mode/index.ts");
  let roster = emptyBotRoster();
  roster = upsertBot(roster, { id: "bot-a", name: "Alpha" });
  roster = upsertBot(roster, { id: "bot-b", name: "Beta" });
  roster = upsertBot(roster, { id: "bot-c", name: "Gamma" });
  roster = createBotGroup(roster, "Desk", ["bot-a", "bot-b", "bot-c"]);
  const group = roster.groups[0];
  const first = planGroupRound({ roster, group, mentionedBotIds: ["bot-b"], round: 0 });
  assert.deepEqual(first.speakerIds, ["bot-b"]);
  const settled = nextGroupRound(first, [{ botId: "bot-b", silent: true }]);
  assert.equal(settled.settled, true);
  assert.equal(planGroupRound({ roster, group, round: 3 }).settled, true);
  assert.equal(parseUserMentions("need @user here"), true);
  const addressed = nextGroupRound(first, [{ botId: "bot-b", silent: false, text: "please ask @user" }]);
  assert.equal(addressed.needsUser, true);
  assert.equal(addressed.settled, true);
});

test("local inference CLI only accepts executable files and non-world-writable credentials", async () => {
  const { isUsableExecutable, isSafeCredentialFile } = await load("source/shared/node/inference-router-local.ts");
  const root = mkdtempSync(path.join(tmpdir(), "grok-cli-"));
  const file = path.join(root, "tool");
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o644);
  assert.equal(isUsableExecutable(file), false);
  chmodSync(file, 0o755);
  assert.equal(isUsableExecutable(file), true);
  assert.equal(isUsableExecutable(root), false);
  const auth = path.join(root, "auth.json");
  writeFileSync(auth, "{}\n");
  chmodSync(auth, 0o644);
  assert.equal(isSafeCredentialFile(auth), true);
  chmodSync(auth, 0o666);
  assert.equal(isSafeCredentialFile(auth), false);
});
