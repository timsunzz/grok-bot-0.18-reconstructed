#!/usr/bin/env node
// Headless bot-mode CLI for the reconstructed Grok Bot inference router.
// Usage:
//   node scripts/bot-mode.mjs --prompt "hello" [--agent bot] [--provider codex] [--data-dir DIR] [--timeout-ms 150000] [--json]
// In bot-mode there is no Electron UI: turns run through the same transcript
// store/schema as the desktop coordinator and stream progress as JSONL.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const prefixed = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefixed));
  if (direct) return direct.slice(prefixed.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function loadBotMode() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-mode-"));
  try {
    const output = path.join(temporary, "bot-mode.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/bot-mode.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["@anthropic-ai/claude-agent-sdk", "@ai-sdk/openai", "ai"],
    });
    return await import(pathToFileURL(output).href);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const prompt = argValue("prompt");
const agentId = argValue("agent") ?? "bot";
const provider = argValue("provider");
const dataDirOverride = argValue("data-dir") ?? argValue("dataDir");
const timeoutRaw = argValue("timeout-ms") ?? argValue("timeoutMs");
const asJson = hasFlag("json");

if (!prompt) {
  console.error('bot-mode: --prompt "..." is required');
  process.exit(2);
}
if (provider !== undefined && !["claude-code", "codex", "openrouter"].includes(provider)) {
  console.error('bot-mode: --provider must be one of claude-code, codex, openrouter (cursor is desktop-only)');
  process.exit(2);
}

const bot = await loadBotMode();
const dataDir = bot.resolveBotDataDir(dataDirOverride);
const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
try {
  const result = await bot.runBotTurn({
    dataDir,
    turn: {
      agentId,
      prompt,
      ...(provider === undefined ? {} : { provider }),
      ...(timeoutMs === undefined || !Number.isFinite(timeoutMs) ? {} : { timeoutMs }),
    },
  });
  if (asJson) {
    console.log(JSON.stringify({ agentId, dataDir, assistantText: result.assistantText, events: result.events }, null, 2));
  } else {
    for (const event of result.events) {
      if (event.family === "transcript") console.log(JSON.stringify({ family: event.family, payload: event.payload }));
    }
    console.log(`\n[bot-mode] agent=${agentId} dataDir=${dataDir}\n${result.assistantText}`);
  }
} catch (error) {
  console.error(`bot-mode failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
