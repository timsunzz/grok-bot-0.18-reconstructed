import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
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
type RoutedRunner = typeof runRoutedProviderText;

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };
const ROUTED_PROVIDERS = ["codex", "claude-code", "openrouter"] as const;

export class InferenceRouterStoreError extends Error {
  readonly code: "unreadable" | "unknown-schema";
  constructor(code: "unreadable" | "unknown-schema", message: string) {
    super(message);
    this.name = "InferenceRouterStoreError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanReactions(value: unknown): readonly { readonly emoji: string; readonly by: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const reactions = value.flatMap((raw) => {
    const reaction = asRecord(raw);
    return reaction != null && typeof reaction.emoji === "string" && typeof reaction.by === "string"
      ? [{ emoji: reaction.emoji, by: reaction.by }]
      : [];
  });
  return reactions.length > 0 ? reactions : undefined;
}

export function inspectInferenceRouterTranscriptStore(value: unknown):
  | { readonly status: "ok"; readonly store: Store }
  | { readonly status: "empty" }
  | { readonly status: "unknown-schema" }
  | { readonly status: "unreadable" } {
  const root = asRecord(value);
  if (root == null) return { status: "unreadable" };
  if (root.schemaVersion == null && asRecord(root.agents) == null && Object.keys(root).length === 0) return { status: "empty" };
  if (root.schemaVersion !== 2) return { status: "unknown-schema" };
  if (asRecord(root.agents) == null) return { status: "unreadable" };
  return { status: "ok", store: parseInferenceRouterTranscriptStore(root) };
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
      if (
        row == null
        || !(ROUTED_PROVIDERS as readonly string[]).includes(String(row.provider))
        || !["user", "assistant"].includes(String(row.role))
        || typeof row.content !== "string"
        || typeof row.id !== "string"
        || !isFiniteNumber(row.timestampMs)
        || (row.clientNonce !== undefined && typeof row.clientNonce !== "string")
        || (row.richText !== undefined && typeof row.richText !== "string")
      ) continue;
      const reactions = cleanReactions(row.reactions);
      entries.push({
        provider: row.provider as StoredEntry["provider"],
        role: row.role as StoredEntry["role"],
        content: row.content,
        id: row.id,
        timestampMs: row.timestampMs,
        ...(typeof row.richText === "string" ? { richText: row.richText } : {}),
        ...(typeof row.clientNonce === "string" ? { clientNonce: row.clientNonce } : {}),
        ...(reactions === undefined ? {} : { reactions }),
      });
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

function highestTurn(ids: readonly string[]): number {
  return ids.reduce((highest, id) => {
    const match = /^t(\d+)(?:u|s\d+)$/.exec(id);
    return match == null ? highest : Math.max(highest, Number(match[1]));
  }, -1);
}

function mergeTranscriptEntries(remote: readonly unknown[], local: readonly Record<string, unknown>[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of [...remote, ...local]) {
    const id = asRecord(entry)?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    merged.push(entry);
  }
  return merged;
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly composeDelayMs?: number;
  readonly runProvider?: RoutedRunner;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const runProvider = options.runProvider ?? runRoutedProviderText;
  const queues = new Map<string, Promise<unknown>>();
  let storeLock: Promise<unknown> = Promise.resolve();

  const withStoreLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = storeLock.catch(() => undefined);
    let release: (value?: unknown) => void = () => {};
    storeLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  };

  const load = async (): Promise<Store> => {
    let raw: string;
    try { raw = await readFile(storePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STORE;
      throw new InferenceRouterStoreError("unreadable", "The routed transcript could not be read.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { throw new InferenceRouterStoreError("unreadable", "The routed transcript is not valid JSON."); }
    const inspected = inspectInferenceRouterTranscriptStore(parsed);
    if (inspected.status === "ok") return inspected.store;
    if (inspected.status === "empty") return EMPTY_STORE;
    if (inspected.status === "unknown-schema") {
      throw new InferenceRouterStoreError("unknown-schema", "The routed transcript uses an unsupported schema and was left unchanged.");
    }
    throw new InferenceRouterStoreError("unreadable", "The routed transcript is damaged and was left unchanged.");
  };

  const persist = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };

  const mutate = async (update: (current: Store) => Store): Promise<Store> => withStoreLock(async () => {
    const next = update(await load());
    await persist(next);
    return next;
  });

  const replaceEntry = async (agentId: string, entry: StoredEntry): Promise<Store> => mutate((current) => {
    const existing = current.agents[agentId] ?? [];
    const index = existing.findIndex((row) => row.id === entry.id);
    const nextEntries = index < 0 ? [...existing, entry] : existing.map((row, rowIndex) => rowIndex === index ? entry : row);
    return { schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries.slice(-200) } };
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
    let projected: Record<string, unknown> | null = null;
    await mutate((current) => {
      const entries = current.agents[agentId];
      if (entries == null) return current;
      const index = entries.findIndex(entry => entry.id === entryId);
      if (index < 0) return current;
      const before = entries[index]!;
      const reactions = before.reactions ?? [];
      const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
      const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
      const { reactions: _oldReactions, ...withoutReactions } = before;
      const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
      const nextEntries = [...entries];
      nextEntries[index] = updated;
      projected = projectInferenceRouterTranscriptEntry(updated);
      return { schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } };
    });
    return projected;
  };

  const admitUserPrompt = async (
    provider: Exclude<SandInferenceProvider, "cursor">,
    args: { readonly agentId: string; readonly prompt: string; readonly richText?: string; readonly clientNonce: string },
  ): Promise<{ readonly duplicate: boolean; readonly turn: number; readonly timestampMs: number }> => {
    const timestampMs = now();
    const remote = await options.dispatchRemote("getAgentTranscriptTail", { id: args.agentId }).catch(() => null);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteTurn = highestTurn(remoteEntries.map((raw) => {
      const id = asRecord(raw)?.id;
      return typeof id === "string" ? id : "";
    }));
    let admitted = { duplicate: false, turn: remoteTurn + 1, timestampMs };
    await mutate((current) => {
      const existing = (current.agents[args.agentId] ?? []).find((entry) => entry.clientNonce === args.clientNonce);
      if (existing != null) {
        admitted = { duplicate: true, turn: highestTurn([existing.id]), timestampMs: existing.timestampMs };
        return current;
      }
      const localTurn = highestTurn((current.agents[args.agentId] ?? []).map((entry) => entry.id));
      const turn = Math.max(remoteTurn, localTurn) + 1;
      const userId = `t${turn}u`;
      admitted = { duplicate: false, turn, timestampMs };
      emitTranscript(args.agentId, "appended", {
        kind: "message",
        id: userId,
        role: "user",
        content: args.prompt,
        ...(args.richText === undefined ? {} : { richText: args.richText }),
        isStreaming: false,
        timestampMs,
        clientNonce: args.clientNonce,
      });
      return {
        schemaVersion: 2,
        agents: {
          ...current.agents,
          [args.agentId]: [
            ...(current.agents[args.agentId] ?? []),
            {
              provider,
              role: "user" as const,
              content: args.prompt,
              ...(args.richText === undefined ? {} : { richText: args.richText }),
              id: userId,
              clientNonce: args.clientNonce,
              timestampMs,
            },
          ].slice(-200),
        },
      };
    });
    return admitted;
  };

  const persistAssistant = async (
    provider: Exclude<SandInferenceProvider, "cursor">,
    agentId: string,
    assistantId: string,
    content: string,
    timestampMs: number,
    started: boolean,
  ): Promise<void> => {
    await replaceEntry(agentId, { provider, role: "assistant", content, id: assistantId, timestampMs });
    emitTranscript(agentId, started ? "updated" : "appended", { kind: "send-message", id: assistantId, message: { type: "text", content }, timestampMs });
  };

  const execute = async (
    provider: Exclude<SandInferenceProvider, "cursor">,
    args: { readonly agentId: string; readonly clientNonce: string; readonly turn: number },
  ) => {
    const { agentId, clientNonce } = args;
    const endActivity = await beginActivity(agentId);
    if ((options.composeDelayMs ?? 1_200) > 0) {
      // The shipped transcript intentionally suppresses its activity row as soon as
      // the first streamed assistant entry arrives. Direct providers can produce that
      // first delta in the same renderer reconciliation window as the roster update,
      // making the genuine composing state imperceptible. The shipped virtualized
      // transcript needs roughly 350 ms to materialize its trailing activity row,
      // so keep the composing state authoritative long enough for a clearly
      // perceptible rendered interval before normal token streaming begins.
      await new Promise<void>(resolve => setTimeout(resolve, 1_200));
    }
    const withUser = await withStoreLock(() => load());
    const messages = (withUser.agents[agentId] ?? []).map(entry => ({ role: entry.role, content: entry.content }));
    const assistantTimestampMs = now();
    const assistantId = `t${args.turn}s0`;
    let assistantStreamStarted = false;
    let streamed = "";
    const emitAssistant = (nextContent: string, streaming: boolean) => {
      streamed = nextContent;
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };
    const bridge = provider === "claude-code" ? await createRoutedMcpBridge({
      listTools: () => options.dispatchRemote("listRoutedMcpTools", {}),
      callTool: tool => options.dispatchRemote("executeRoutedMcpTool", { ...tool, agentId }),
    }) : null;
    const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}) : undefined;
    const tools = Array.isArray(directTools) ? directTools as Record<string, any>[] : undefined;
    const onTextDelta = (_delta: string, accumulated: string) => emitAssistant(accumulated, true);
    try {
      const content = await runProvider(provider, messages, bridge == null ? {
        ...(tools === undefined ? {} : { tools }),
        executeTool: async (definition, toolArgs, toolCallId) => await options.dispatchRemote("executeRoutedMcpTool", {
          providerIdentifier: definition.providerIdentifier,
          name: definition.name,
          toolName: definition.toolName,
          args: toolArgs,
          toolCallId,
          agentId,
        }),
        onTextDelta,
        settingsPath: join(options.dataDir, "settings.json"),
      } : { mcpServerUrl: bridge.url, onTextDelta, settingsPath: join(options.dataDir, "settings.json") });
      await persistAssistant(provider, agentId, assistantId, content, assistantTimestampMs, assistantStreamStarted);
      emitAssistant(content, false);
      return { accepted: true, clientNonce, provider };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const content = streamed.length > 0 ? `${streamed}\n\nRouter error: ${detail}` : `Router error: ${detail}`;
      await persistAssistant(provider, agentId, assistantId, content, assistantTimestampMs, assistantStreamStarted);
      return { accepted: true, clientNonce, provider, error: detail };
    } finally {
      endActivity();
      await bridge?.close();
    }
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
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
        const remote = await options.dispatchRemote(method, args).catch(() => null);
        const local = await withStoreLock(() => load()).catch(() => EMPTY_STORE);
        const result = asRecord(remote);
        const remoteEntries = result != null && Array.isArray(result.entries) ? result.entries : [];
        const localEntries = agentId.length === 0 ? [] : (local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry);
        if (agentId.length === 0 && result != null) return { handled: true, value: remote };
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...(result ?? {}), entries: mergeTranscriptEntries(remoteEntries, localEntries).slice(-limit) } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const richText = typeof record.richText === "string" ? record.richText : undefined;
      const clientNonce = typeof record.clientNonce === "string" && record.clientNonce.length > 0 ? record.clientNonce : randomUUID();
      if (agentId.length === 0 || prompt.length === 0) {
        return { handled: true, value: { accepted: false, clientNonce, provider, error: "Local inference routing requires an agentId and prompt" } };
      }
      let admitted: { readonly duplicate: boolean; readonly turn: number; readonly timestampMs: number };
      try {
        admitted = await admitUserPrompt(provider, { agentId, prompt, ...(richText === undefined ? {} : { richText }), clientNonce });
      } catch (error) {
        return {
          handled: true,
          value: {
            accepted: false,
            clientNonce,
            provider,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (admitted.duplicate) {
        return { handled: true, value: { accepted: true, clientNonce, provider, duplicate: true } };
      }
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, { agentId, clientNonce, turn: admitted.turn }));
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce, provider } };
    },
  };
}
