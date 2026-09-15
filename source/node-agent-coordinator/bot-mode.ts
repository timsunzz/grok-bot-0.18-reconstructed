import { join } from "node:path";
import { homedir } from "node:os";

import type { SandInferenceProvider } from "../shared/inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createCoordinatorInferenceRouter } from "./inference-router.js";

/**
 * Headless bot-mode for the reconstructed Grok Bot router.
 *
 * Desktop mode = Electron main + coordinator + host/gateway + polished
 * shipped renderer. Bot-mode keeps the same inference router, transcript
 * schema (schemaVersion 2, t{turn}u / t{turn}s0 ids, 200-entry cap), settings
 * store, and usage accounting, but drops the UI and desktop tool executors:
 *
 * - same: provider selection (cursor is desktop-only; claude-code / codex /
 *   openrouter run headless), transcript persistence + projection, per-agent
 *   sendPrompt queue, local reaction toggling, usage recording.
 * - different: no Electron, no remote box/gateway roster, no shipped
 *   renderer activity pulse target (events are JSONL instead), MCP tool list
 *   is empty and tool execution fails closed with a bot-mode error rather
 *   than dispatching to desktop plugins.
 *
 * This mirrors the typical hermes-agent style bot-mode split (interactive
 * desktop vs. headless single-agent loop) while reusing one router
 * implementation so the two modes cannot drift apart.
 */

export interface BotTurnRequest {
  readonly agentId: string;
  readonly prompt: string;
  readonly richText?: string;
  readonly clientNonce?: string;
  readonly provider?: Exclude<SandInferenceProvider, "cursor">;
  readonly timeoutMs?: number;
}

export interface BotTranscriptEvent {
  readonly family: string;
  readonly payload: unknown;
}

export function resolveBotDataDir(override?: string): string {
  const explicit = (override ?? process.env.SAND_BOT_DATA_DIR ?? "").trim();
  if (explicit.length > 0) return explicit;
  return join(homedir(), ".grok-bot-bot-mode");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isFinalAssistantEvent(payload: unknown, agentId: string): { done: boolean; failed: boolean } {
  const root = asRecord(payload);
  if (root?.agentId !== agentId) return { done: false, failed: false };
  const entry = asRecord(root.entry);
  if (entry?.kind !== "send-message") return { done: false, failed: false };
  // Router emits `streaming: false` on the settled assistant entry; unknown
  // shapes are treated as non-final so we keep waiting for the settled event.
  if ((entry.streaming as unknown) !== false) return { done: false, failed: false };
  const message = asRecord(entry.message);
  const content = typeof message?.content === "string" ? message.content : "";
  return { done: true, failed: content.startsWith("Router error:") };
}

export async function runBotTurn(options: {
  readonly dataDir: string;
  readonly turn: BotTurnRequest;
}): Promise<{ readonly events: readonly BotTranscriptEvent[]; readonly assistantText: string }> {
  const agentId = options.turn.agentId.trim();
  const prompt = options.turn.prompt;
  if (agentId.length === 0 || prompt.length === 0) {
    throw new Error("bot-mode requires a non-empty agentId and prompt");
  }
  if (options.turn.provider !== undefined) {
    new SandSettingsStore(join(options.dataDir, "settings.json")).setInferenceProvider(options.turn.provider);
  }

  const events: BotTranscriptEvent[] = [];
  let settled: ((value: { text: string; failed: boolean }) => void) | null = null;
  const completion = new Promise<{ text: string; failed: boolean }>((resolve) => {
    settled = resolve;
  });

  const router = createCoordinatorInferenceRouter({
    dataDir: options.dataDir,
    postEvent: (family, payload) => {
      events.push({ family, payload });
      if (family !== "transcript") return;
      const root = asRecord(payload);
      if (root?.type !== "appended") return;
      const verdict = isFinalAssistantEvent(payload, agentId);
      if (verdict.done) {
        const entry = asRecord(asRecord(payload)?.entry);
        const message = asRecord(entry?.message);
        const text = typeof message?.content === "string" ? message.content : "";
        settled?.({ text, failed: verdict.failed });
        settled = null;
      }
    },
    dispatchRemote: async (method, args) => {
      if (method === "listAgents") return [{ id: agentId, isRunning: false }];
      if (method === "getAgentTranscriptTail" || method === "openAgentTail" || method === "getAgentTranscriptWindow") {
        return { entries: [] };
      }
      if (method === "listRoutedMcpTools") return [];
      if (method === "executeRoutedMcpTool") {
        const name = asRecord(args)?.toolName ?? asRecord(args)?.name ?? "unknown";
        throw new Error(`Tool ${String(name)} is unavailable in bot-mode (no desktop plugins).`);
      }
      throw new Error(`bot-mode has no remote method: ${method}`);
    },
  });

  const outcome = await router.dispatch("sendPrompt", {
    agentId,
    prompt,
    ...(options.turn.richText === undefined ? {} : { richText: options.turn.richText }),
    ...(options.turn.clientNonce === undefined ? {} : { clientNonce: options.turn.clientNonce }),
  });
  if (!outcome.handled) {
    throw new Error("bot-mode turn was not accepted (is the provider set to cursor?).");
  }

  const timeoutMs = options.turn.timeoutMs ?? 150_000;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      settled?.({ text: "", failed: true });
      settled = null;
    }, timeoutMs)
    : null;
  timer?.unref?.();
  try {
    const result = await completion;
    if (result.text.length === 0 && result.failed) {
      const lastError = [...events].reverse().find((event) => event.family === "transcript");
      const entry = asRecord(asRecord(lastError?.payload)?.entry);
      const message = asRecord(entry?.message);
      const detail = typeof message?.content === "string" && message.content.length > 0
        ? message.content
        : `bot-mode turn for agent ${agentId} did not settle within ${timeoutMs} ms.`;
      throw new Error(detail);
    }
    return { events, assistantText: result.text };
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
