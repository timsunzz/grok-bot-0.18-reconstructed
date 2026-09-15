import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertRoutedProviderReady, runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import {
  ConversationLoopGuard,
  DEFAULT_ROUTER_COMPOSE_DELAY_MS,
  DEFAULT_ROUTER_RETRY_DELAY_MS,
  DEFAULT_ROUTER_TURN_TIMEOUT_MS,
  DEFAULT_TURN_GUARD_COOLDOWN_MS,
  DEFAULT_TURN_GUARD_MAX_EVENTS,
  DEFAULT_TURN_GUARD_WINDOW_MS,
  ToolLoopGuard,
  assistantEntryId,
  classifyProviderFailure,
  envInt,
  formatRouterError,
  isTransientProviderFailure,
  nextTranscriptTurn,
  sleep as defaultSleep,
  userEntryId,
  withTurnTimeout,
} from "../shared/inference-router-runtime.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";

type StoredEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };
type RunProvider = typeof runRoutedProviderText;

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseInferenceRouterTranscriptStore(value: unknown): Store {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !["codex", "claude-code", "openrouter"].includes(String(row.provider)) || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number" || (row.clientNonce !== undefined && typeof row.clientNonce !== "string") || (row.richText !== undefined && typeof row.richText !== "string")) continue;
      if (row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(reaction => asRecord(reaction) == null || typeof asRecord(reaction)!.emoji !== "string" || typeof asRecord(reaction)!.by !== "string"))) continue;
      entries.push(row as unknown as StoredEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) }
    : { kind: "send-message", id: entry.id, message: { type: "text", content: entry.content }, timestampMs: entry.timestampMs, ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) };
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly composeDelayMs?: number;
  readonly turnTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly runProvider?: RunProvider;
  readonly assertReady?: (provider: Exclude<SandInferenceProvider, "cursor">) => void;
  readonly sleep?: typeof defaultSleep;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const composeDelayMs = options.composeDelayMs ?? envInt("SAND_ROUTER_COMPOSE_DELAY_MS", DEFAULT_ROUTER_COMPOSE_DELAY_MS);
  const turnTimeoutMs = options.turnTimeoutMs ?? envInt("SAND_ROUTER_TURN_TIMEOUT_MS", DEFAULT_ROUTER_TURN_TIMEOUT_MS);
  const retryDelayMs = options.retryDelayMs ?? envInt("SAND_ROUTER_RETRY_DELAY_MS", DEFAULT_ROUTER_RETRY_DELAY_MS);
  const runProvider = options.runProvider ?? runRoutedProviderText;
  const assertReady = options.assertReady ?? assertRoutedProviderReady;
  const sleep = options.sleep ?? defaultSleep;
  const queues = new Map<string, Promise<unknown>>();
  const turnGuard = new ConversationLoopGuard(
    envInt("SAND_ROUTER_TURN_GUARD_MAX", DEFAULT_TURN_GUARD_MAX_EVENTS),
    envInt("SAND_ROUTER_TURN_GUARD_WINDOW_MS", DEFAULT_TURN_GUARD_WINDOW_MS),
    envInt("SAND_ROUTER_TURN_GUARD_COOLDOWN_MS", DEFAULT_TURN_GUARD_COOLDOWN_MS),
    now,
  );
  let writeChain = Promise.resolve();

  const load = async (): Promise<Store> => {
    try { return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8"))); }
    catch { return EMPTY_STORE; }
  };
  const persist = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };
  const mutate = <T>(fn: (store: Store) => { store: Store; value: T } | Promise<{ store: Store; value: T }>): Promise<T> => {
    const run = writeChain.then(async () => {
      const current = await load();
      const result = await fn(current);
      if (result.store !== current) await persist(result.store);
      return result.value;
    });
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  };
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => mutate(current => {
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    return { store: next, value: next };
  });
  const upsert = async (agentId: string, entry: StoredEntry): Promise<Store> => mutate(current => {
    const entries = [...(current.agents[agentId] ?? [])];
    const index = entries.findIndex(item => item.id === entry.id);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: entries.slice(-200) } };
    return { store: next, value: next };
  });
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  const beginActivity = async (agentId: string): Promise<() => void> => {
    try {
      const remote = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(remote)) return () => {};
      const project = (isRunning: boolean) => remote.map(raw => {
        const row = asRecord(raw);
        if (row?.id !== agentId) return raw;
        return { ...row, isRunning, isRunningTurn: isRunning, isComposingMessage: isRunning, isRetrying: false, ...(isRunning ? { currentActivity: { kind: "thinking" } } : { currentActivity: undefined }) };
      });
      const publishRunning = () => options.postEvent("agents", { activeAgentId: agentId, agents: project(true) });
      publishRunning();
      // Transcript refreshes can fetch the remote (idle) roster while a local CLI turn is
      // running. Pulse the locally authoritative state until the turn settles so those
      // refreshes cannot permanently erase the polished renderer's activity surface.
      const pulse = setInterval(publishRunning, 250);
      pulse.unref();
      return () => {
        clearInterval(pulse);
        options.postEvent("agents", { activeAgentId: agentId, agents: project(false) });
      };
    } catch { return () => {}; }
  };
  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    return mutate(current => {
      const entries = current.agents[agentId];
      if (entries == null) return { store: current, value: null };
      const index = entries.findIndex(entry => entry.id === entryId);
      if (index < 0) return { store: current, value: null };
      const before = entries[index]!;
      const reactions = before.reactions ?? [];
      const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
      const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
      const { reactions: _oldReactions, ...withoutReactions } = before;
      const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
      const nextEntries = [...entries];
      nextEntries[index] = updated;
      return { store: { schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } }, value: projectInferenceRouterTranscriptEntry(updated) };
    });
  };
  const persistFailure = async (agentId: string, provider: Exclude<SandInferenceProvider, "cursor">, error: unknown, assistantId?: string, timestampMs = now()) => {
    const reason = classifyProviderFailure(error);
    const content = formatRouterError(error, reason);
    const id = assistantId ?? await mutate(current => {
      const turn = nextTranscriptTurn((current.agents[agentId] ?? []).map(entry => entry.id));
      return { store: current, value: assistantEntryId(turn) };
    });
    await upsert(agentId, { provider, role: "assistant", content, id, timestampMs });
    emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs });
    return { accepted: false as const, reason, error: content, provider };
  };
  const executeProvider = async (
    provider: Exclude<SandInferenceProvider, "cursor">,
    messages: readonly { role: StoredEntry["role"]; content: string }[],
    onTextDelta: (delta: string, accumulated: string) => void,
    agentId: string,
  ): Promise<string> => {
    const toolLoop = new ToolLoopGuard();
    const bridge = provider === "claude-code" ? await createRoutedMcpBridge({
      listTools: () => options.dispatchRemote("listRoutedMcpTools", {}),
      callTool: tool => options.dispatchRemote("executeRoutedMcpTool", { ...tool, agentId }),
      toolLoop,
    }) : null;
    const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}) : undefined;
    const tools = Array.isArray(directTools) ? directTools as Record<string, any>[] : undefined;
    const runOnce = (signal: AbortSignal) => runProvider(provider, messages, bridge == null ? {
      ...(tools === undefined ? {} : { tools }),
      executeTool: async (definition, toolArgs, toolCallId) => {
        const admission = toolLoop.admit(typeof definition.name === "string" ? definition.name : "unknown", toolArgs);
        if (!admission.allowed) throw new Error(`Tool loop guard blocked repeated ${String(definition.name)} calls.`);
        return await options.dispatchRemote("executeRoutedMcpTool", {
          providerIdentifier: definition.providerIdentifier,
          name: definition.name,
          toolName: definition.toolName,
          args: toolArgs,
          toolCallId,
          agentId,
        });
      },
      onTextDelta,
      abortSignal: signal,
    } : { mcpServerUrl: bridge.url, onTextDelta, abortSignal: signal, toolLoop });
    try {
      return await withTurnTimeout(async signal => {
        try {
          return await runOnce(signal);
        } catch (error) {
          if (!isTransientProviderFailure(classifyProviderFailure(error)) || signal.aborted) throw error;
          await sleep(retryDelayMs, signal);
          return await runOnce(signal);
        }
      }, turnTimeoutMs);
    } finally {
      await bridge?.close();
    }
  };
  const execute = async (provider: Exclude<SandInferenceProvider, "cursor">, args: Record<string, unknown>) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) return { accepted: false, clientNonce, provider, reason: "invalid_request" as const, error: "Local inference routing requires an agentId and prompt" };
    const timestampMs = now();
    const [remote, beforeUser] = await Promise.all([options.dispatchRemote("getAgentTranscriptTail", { id: agentId }), mutate(async store => ({ store, value: store }))]);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteIds = remoteEntries.flatMap(raw => {
      const id = asRecord(raw)?.id;
      return typeof id === "string" ? [id] : [];
    });
    const turn = nextTranscriptTurn(remoteIds, (beforeUser.agents[agentId] ?? []).map(entry => entry.id));
    const userId = userEntryId(turn);
    const assistantId = assistantEntryId(turn);
    const userEntry = { kind: "message", id: userId, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userId, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);
    const endActivity = await beginActivity(agentId);
    // The shipped transcript intentionally suppresses its activity row as soon as
    // the first streamed assistant entry arrives. Direct providers can produce that
    // first delta in the same renderer reconciliation window as the roster update,
    // making the genuine composing state imperceptible. The shipped virtualized
    // transcript needs roughly 350 ms to materialize its trailing activity row,
    // so keep the composing state authoritative long enough for a clearly
    // perceptible rendered interval before normal token streaming begins.
    let assistantStreamStarted = false;
    const assistantTimestampMs = now();
    const emitAssistant = (nextContent: string, streaming: boolean, type: "appended" | "updated" = assistantStreamStarted ? "updated" : "appended") => {
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, type, entry);
      assistantStreamStarted = true;
    };
    try {
      assertReady(provider);
      await sleep(composeDelayMs);
      const messages = ((await mutate(async store => ({ store, value: store }))).agents[agentId] ?? []).map(entry => ({ role: entry.role, content: entry.content }));
      const content = await executeProvider(provider, messages, (_delta, accumulated) => emitAssistant(accumulated, true), agentId);
      await upsert(agentId, { provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs });
      emitAssistant(content, false);
      return { accepted: true, clientNonce, provider };
    } catch (error) {
      const content = formatRouterError(error);
      await upsert(agentId, { provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs });
      emitAssistant(content, false, assistantStreamStarted ? "updated" : "appended");
      return { accepted: false, clientNonce, provider, reason: classifyProviderFailure(error), error: content };
    } finally {
      endActivity();
    }
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    async waitUntilIdle(agentId?: string): Promise<void> {
      if (agentId != null) {
        await (queues.get(agentId) ?? Promise.resolve());
        return;
      }
      await Promise.all([...queues.values()]);
    },
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "reactToMessage") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), mutate(async store => ({ store, value: store }))]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const entries = [...result.entries, ...(local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry)];
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: entries.slice(-limit) } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      if (agentId.length === 0 || prompt.length === 0) {
        return { handled: true, value: { accepted: false, clientNonce: record.clientNonce, provider, reason: "invalid_request", error: "Local inference routing requires an agentId and prompt" } };
      }
      const admission = turnGuard.admit(agentId);
      if (!admission.allowed) {
        const error = formatRouterError(new Error(`Turn loop guard ${admission.state} for this conversation.`), "turn_loop_guard");
        return { handled: true, value: { accepted: false, clientNonce: record.clientNonce, provider, reason: "turn_loop_guard", error } };
      }
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, record)).catch(async (error) => persistFailure(agentId, provider, error));
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}
