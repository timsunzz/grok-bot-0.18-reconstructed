import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/shared/bot-mode.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("bot session keys match Hermes-style routing identity", async () => {
  const {
    buildBotSessionKey,
    parseBotSessionKey,
  } = await loadModule();
  const key = buildBotSessionKey({
    agentId: "main",
    platform: "telegram",
    chatType: "private",
    chatId: "123456789",
  });
  assert.equal(key, "agent:main:telegram:private:123456789");
  assert.deepEqual(parseBotSessionKey(key), {
    agentId: "main",
    platform: "telegram",
    chatType: "private",
    chatId: "123456789",
  });
  const threaded = buildBotSessionKey({
    agentId: "agent-1",
    platform: "discord",
    chatType: "thread",
    chatId: "C99",
    threadId: "T1",
  });
  assert.equal(threaded, "agent:agent-1:discord:thread:C99:T1");
  assert.equal(parseBotSessionKey("not-a-key"), null);
  assert.throws(() => buildBotSessionKey({ agentId: "a", platform: "", chatId: "1" }), /platform and chat/);
});

test("authorization defaults to allow on a personal desktop, deny when an allowlist exists", async () => {
  const { authorizeBotSender } = await loadModule();
  assert.deepEqual(authorizeBotSender("alice"), { allowed: true });
  assert.deepEqual(authorizeBotSender("alice", { allowedUsers: ["bob"] }), { allowed: false, reason: "not-allowlisted" });
  assert.deepEqual(authorizeBotSender("bob", { allowedUsers: ["bob"] }), { allowed: true });
  assert.deepEqual(authorizeBotSender("eve", { allowAll: true, allowedUsers: ["bob"] }), { allowed: true });
  assert.deepEqual(authorizeBotSender("eve", { platformAllowAll: true }), { allowed: true });
  assert.deepEqual(authorizeBotSender("   "), { allowed: false, reason: "empty-sender" });
});

test("group mention policy mirrors Hermes require_mention and ignore_no_mention", async () => {
  const { admitBotInboundMessage } = await loadModule();
  assert.deepEqual(admitBotInboundMessage({ chatType: "private", mentionedBot: false }), { admit: true });
  assert.deepEqual(
    admitBotInboundMessage({ chatType: "group", requireMention: true, mentionedBot: false }),
    { admit: false, reason: "require-mention" },
  );
  assert.deepEqual(
    admitBotInboundMessage({ chatType: "group", requireMention: true, mentionedBot: true }),
    { admit: true },
  );
  assert.deepEqual(
    admitBotInboundMessage({ chatType: "channel", mentionedOthers: true, mentionedBot: false }),
    { admit: false, reason: "directed-elsewhere" },
  );
  assert.deepEqual(
    admitBotInboundMessage({ chatType: "group", mentionedOthers: true, mentionedBot: true }),
    { admit: true },
  );
});

test("busy-session guard queues mid-turn messages, bypasses slash commands, and drops at cap", async () => {
  const { createBotSessionGuard, parseBotBusyCommand } = await loadModule();
  assert.equal(parseBotBusyCommand("/stop now"), "stop");
  assert.equal(parseBotBusyCommand("please /stop"), null);
  const guard = createBotSessionGuard({ queueCap: 2 });
  assert.deepEqual(guard.admit("s1", { n: 1 }, "hello"), { action: "run" });
  guard.begin("s1");
  assert.deepEqual(guard.admit("s1", { n: 2 }, "follow-up"), { action: "queue", queued: 1 });
  assert.deepEqual(guard.admit("s1", { n: 3 }, "again"), { action: "queue", queued: 2 });
  assert.deepEqual(guard.admit("s1", { n: 4 }, "overflow"), { action: "drop", reason: "queue-cap" });
  assert.deepEqual(guard.admit("s1", { n: 5 }, "/stop"), { action: "busy-command", command: "stop" });
  assert.deepEqual(guard.drain("s1"), [{ n: 2 }, { n: 3 }]);
  assert.deepEqual(guard.drain("s1"), []);
  guard.end("s1");
  assert.equal(guard.isRunning("s1"), false);
});

test("rate limiter and event dedupe protect a session from floods and replays", async () => {
  const { createBotRateLimiter, createBotEventDedupe } = await loadModule();
  let now = 1_000;
  const limiter = createBotRateLimiter({ maxTokens: 2, refillEveryMs: 100, now: () => now });
  assert.equal(limiter.take("chat").allowed, true);
  assert.equal(limiter.take("chat").allowed, true);
  const blocked = limiter.take("chat");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  now += 100;
  assert.equal(limiter.take("chat").allowed, true);

  const dedupe = createBotEventDedupe({ ttlMs: 50, now: () => now });
  assert.equal(dedupe.seen("evt-1"), false);
  assert.equal(dedupe.seen("evt-1"), true);
  now += 51;
  assert.equal(dedupe.seen("evt-1"), false);
});

test("routed provider errors are classified for retry and user-visible copy", async () => {
  const {
    classifyRoutedProviderError,
    formatRoutedProviderError,
    RoutedTurnTimeoutError,
    RoutedTurnCancelledError,
    runWithRoutedRetry,
    withRoutedTurnDeadline,
    resolveRoutedTurnTimeoutMs,
  } = await loadModule();
  assert.equal(classifyRoutedProviderError(new Error("Codex is not signed in with ChatGPT.")).kind, "auth");
  assert.equal(classifyRoutedProviderError(new Error("OpenRouter needs OPENROUTER_API_KEY")).retryable, false);
  assert.equal(classifyRoutedProviderError(new Error("429 Too Many Requests")).kind, "rate_limit");
  assert.equal(classifyRoutedProviderError(new Error("ECONNRESET")).kind, "transient");
  assert.equal(classifyRoutedProviderError(new RoutedTurnTimeoutError(1_000)).kind, "timeout");
  assert.equal(classifyRoutedProviderError(new RoutedTurnCancelledError()).retryable, false);
  assert.match(formatRoutedProviderError("codex", classifyRoutedProviderError(new Error("socket hang up"))), /codex\/transient/);
  assert.equal(resolveRoutedTurnTimeoutMs({ SAND_ROUTED_TURN_TIMEOUT_MS: "45000" }), 45_000);

  let attempts = 0;
  const recovered = await runWithRoutedRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("ECONNRESET");
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} });
  assert.equal(recovered, "ok");
  assert.equal(attempts, 3);

  await assert.rejects(
    () => withRoutedTurnDeadline(() => new Promise(() => {}), { timeoutMs: 15 }),
    (error) => error instanceof RoutedTurnTimeoutError || error?.name === "RoutedTurnTimeoutError",
  );
});
