import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import {
  asBotFailure,
  attributedBotMessage,
  botModeSystemPrompt,
  createBotGroup,
  createQueuedDelivery,
  deleteBot,
  findBot,
  formatBotFailure,
  hideBot,
  isTransientBotFailure,
  MESSAGE_AGENT_TOOL,
  MESSAGE_AGENT_TOOL_NAME,
  parseBotRoster,
  parseMessageAgentArgs,
  resolveBotProvider,
  resolveMentions,
  stripSilenceToken,
  upsertBot,
  validateMessageAgent,
  type BotProfile,
  type BotRoster,
} from "../shared/bot-mode/index.js";
import { isSandInferenceProvider, type SandInferenceProvider } from "../shared/inference-router.js";
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

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };
export const ROUTER_COMPOSE_DELAY_MS = 1_200;
const TRANSCRIPT_TURN_PATTERN = /^t(\d+)(?:u|s\d+)$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseReactions(value: unknown): readonly { readonly emoji: string; readonly by: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const reactions: { readonly emoji: string; readonly by: string }[] = [];
  for (const raw of value) {
    const reaction = asRecord(raw);
    if (reaction == null || typeof reaction.emoji !== "string" || typeof reaction.by !== "string") continue;
    reactions.push({ emoji: reaction.emoji, by: reaction.by });
  }
  return reactions.length > 0 ? reactions : undefined;
}

export function highestTranscriptTurn(ids: readonly string[]): number {
  let highest = -1;
  for (const id of ids) {
    const match = TRANSCRIPT_TURN_PATTERN.exec(id);
    if (match != null) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
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
      const reactions = parseReactions(row.reactions);
      entries.push({
        provider: row.provider as StoredEntry["provider"],
        role: row.role as StoredEntry["role"],
        content: row.content,
        id: row.id,
        timestampMs: row.timestampMs,
        ...(row.clientNonce === undefined ? {} : { clientNonce: row.clientNonce }),
        ...(row.richText === undefined ? {} : { richText: row.richText }),
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

function composeDelayMs(): number {
  const raw = process.env.GROK_BOT_ROUTER_COMPOSE_DELAY_MS;
  if (raw == null || raw.trim().length === 0) return ROUTER_COMPOSE_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ROUTER_COMPOSE_DELAY_MS;
}

function ensureRosterBot(roster: BotRoster, agentId: string): { roster: BotRoster; bot: BotProfile } {
  const existing = roster.bots.find(bot => bot.id === agentId);
  if (existing != null) return { roster, bot: existing };
  const fallback: BotProfile = { id: agentId, slug: "bot", name: "Bot", title: "", description: "", hidden: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    const created = upsertBot(roster, { id: agentId, name: agentId.slice(0, 48) || "Bot" });
    return { roster: created, bot: created.bots.find(item => item.id === agentId) ?? fallback };
  } catch {
    return { roster, bot: fallback };
  }
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  let storeTail: Promise<unknown> = Promise.resolve();

  const loadUnlocked = async (): Promise<Store> => {
    try { return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8"))); }
    catch { return EMPTY_STORE; }
  };
  const persistUnlocked = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };
  const withStore = async <T>(mutator: (store: Store) => Promise<{ store: Store; value: T }> | { store: Store; value: T }): Promise<T> => {
    const run = storeTail.catch(() => undefined).then(async () => {
      const current = await loadUnlocked();
      const next = await mutator(current);
      if (next.store !== current) await persistUnlocked(next.store);
      return next.value;
    });
    storeTail = run.catch(() => undefined);
    return run;
  };
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => withStore(current => {
    const store: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    return { store, value: store };
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
    return withStore(current => {
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
  const runProvider = async (provider: Exclude<SandInferenceProvider, "cursor">, messages: readonly { role: "user" | "assistant"; content: string }[], tools: Record<string, any>[] | undefined, executeTool: ((definition: Record<string, any>, toolArgs: unknown, toolCallId: string) => Promise<unknown>) | undefined, mcpServerUrl: string | undefined, systemExtra: string, onTextDelta: (delta: string, accumulated: string) => void): Promise<string> => {
    const invoke = () => runRoutedProviderText(provider, messages, mcpServerUrl == null ? {
      ...(tools === undefined ? {} : { tools }),
      ...(executeTool === undefined ? {} : { executeTool }),
      onTextDelta,
      systemExtra,
    } : { mcpServerUrl, onTextDelta, systemExtra });
    try {
      return await invoke();
    } catch (error) {
      const failure = asBotFailure(error);
      if (!isTransientBotFailure(failure.reason)) throw failure;
      try {
        return await invoke();
      } catch (retryError) {
        throw asBotFailure(retryError);
      }
    }
  };
  const execute = async (provider: Exclude<SandInferenceProvider, "cursor">, args: Record<string, unknown>) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) throw new Error("Local inference routing requires an agentId and prompt");
    const timestampMs = now();
    const [remote, beforeUser] = await Promise.all([options.dispatchRemote("getAgentTranscriptTail", { id: agentId }), withStore(async store => ({ store, value: store }))]);
    const existingNonce = (beforeUser.agents[agentId] ?? []).find(entry => entry.clientNonce === clientNonce);
    if (existingNonce != null) return { accepted: true, clientNonce, provider, idempotent: true };
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteTurn = highestTranscriptTurn(remoteEntries.map(raw => typeof asRecord(raw)?.id === "string" ? String(asRecord(raw)!.id) : ""));
    const localTurn = highestTranscriptTurn((beforeUser.agents[agentId] ?? []).map(entry => entry.id));
    const turn = Math.max(remoteTurn, localTurn) + 1;
    const userEntry = { kind: "message", id: `t${turn}u`, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    const withUser = await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);
    const endActivity = await beginActivity(agentId);
    // The shipped transcript intentionally suppresses its activity row as soon as
    // the first streamed assistant entry arrives. Direct providers can produce that
    // first delta in the same renderer reconciliation window as the roster update,
    // making the genuine composing state imperceptible. The shipped virtualized
    // transcript needs roughly 350 ms to materialize its trailing activity row,
    // so keep the composing state authoritative long enough for a clearly
    // perceptible rendered interval before normal token streaming begins.
    const assistantTimestampMs = now();
    const assistantId = `t${turn}s0`;
    let assistantStreamStarted = false;
    const emitAssistant = (nextContent: string, streaming: boolean) => {
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };
    let bridge: Awaited<ReturnType<typeof createRoutedMcpBridge>> | null = null;
    let content = "";
    try {
      await new Promise<void>(resolve => setTimeout(resolve, composeDelayMs()));
      const roster = parseBotRoster(settings.getBotRoster());
      const { roster: nextRoster, bot } = ensureRosterBot(roster, agentId);
      if (nextRoster !== roster) settings.setBotRoster(nextRoster);
      const mentions = resolveMentions(prompt, nextRoster);
      const systemExtra = botModeSystemPrompt({ roster: nextRoster, bot, mentioned: mentions.map(mention => mention.bot) });
      const messages = (withUser.agents[agentId] ?? []).map(entry => ({ role: entry.role, content: entry.content }));
      const messageAgentTool = {
        name: MESSAGE_AGENT_TOOL_NAME,
        providerIdentifier: "grok-bot",
        toolName: MESSAGE_AGENT_TOOL_NAME,
        description: MESSAGE_AGENT_TOOL.description,
        inputSchema: MESSAGE_AGENT_TOOL.inputSchema,
      };
      bridge = provider === "claude-code" ? await createRoutedMcpBridge({
        listTools: async () => {
          const remote = await options.dispatchRemote("listRoutedMcpTools", {});
          return [...(Array.isArray(remote) ? remote : []), messageAgentTool];
        },
        callTool: tool => tool.name === MESSAGE_AGENT_TOOL_NAME
          ? deliverMessageAgent(agentId, tool.args)
          : options.dispatchRemote("executeRoutedMcpTool", { ...tool, agentId }),
      }) : null;
      const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}) : undefined;
      const tools = [
        ...(Array.isArray(directTools) ? directTools as Record<string, any>[] : []),
        { ...MESSAGE_AGENT_TOOL, parameters: MESSAGE_AGENT_TOOL.inputSchema },
      ];
      const onTextDelta = (_delta: string, accumulated: string) => emitAssistant(accumulated, true);
      const executeTool = async (definition: Record<string, any>, toolArgs: unknown, toolCallId: string) => {
        if (definition.name === MESSAGE_AGENT_TOOL_NAME || definition.toolName === MESSAGE_AGENT_TOOL_NAME) {
          return deliverMessageAgent(agentId, toolArgs);
        }
        return await options.dispatchRemote("executeRoutedMcpTool", {
          providerIdentifier: definition.providerIdentifier,
          name: definition.name,
          toolName: definition.toolName,
          args: toolArgs,
          toolCallId,
          agentId,
        });
      };
      try {
        content = await runProvider(provider, messages, bridge == null ? tools : undefined, executeTool, bridge?.url, systemExtra, onTextDelta);
      } catch (error) {
        const failure = asBotFailure(error);
        content = formatBotFailure(failure.reason, failure.message.replace(/^\[reason:[a-z_]+\]\s*/, ""));
      }
    } catch (error) {
      const failure = asBotFailure(error);
      content = formatBotFailure(failure.reason, failure.message.replace(/^\[reason:[a-z_]+\]\s*/, ""));
    } finally {
      endActivity();
      await bridge?.close();
    }
    const visible = stripSilenceToken(content);
    const storedContent = visible.silent ? "[SILENT]" : visible.visible;
    await append(agentId, [{ provider, role: "assistant", content: storedContent, id: assistantId, timestampMs: assistantTimestampMs }]);
    emitAssistant(storedContent, false);
    return { accepted: true, clientNonce, provider };
  };
  const deliverMessageAgent = async (fromBotId: string, rawArgs: unknown) => {
    const roster = parseBotRoster(settings.getBotRoster());
    const parsed = parseMessageAgentArgs(rawArgs);
    if (parsed == null) return { result: { case: "error", value: { reason: "missing_config", message: "message_agent requires target and message." } } };
    const check = validateMessageAgent(roster, fromBotId, parsed);
    if (!check.ok) return { result: { case: "error", value: { reason: check.reason, message: check.error } } };
    const sender = findBot(roster, fromBotId);
    if (sender == null) return { result: { case: "error", value: { reason: "missing_config", message: "Unknown sender." } } };
    const delivery = createQueuedDelivery({ fromBotId, toBotId: check.targetId, message: parsed.message, ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }) });
    const attributed = attributedBotMessage(sender, parsed.message);
    const targetProvider = resolveBotProvider(roster, check.targetId, settings.getInferenceProvider());
    if (targetProvider === "cursor") {
      try {
        await options.dispatchRemote("sendPrompt", { agentId: check.targetId, prompt: attributed, clientNonce: delivery.idempotencyKey });
      } catch (error) {
        const failure = asBotFailure(error);
        return { result: { case: "error", value: { reason: failure.reason, message: failure.message, deliveryId: delivery.id, status: "failed" } } };
      }
      return { result: { case: "success", value: { deliveryId: delivery.id, status: "queued", target: check.targetId } } };
    }
    const previous = queues.get(check.targetId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => execute(targetProvider, { agentId: check.targetId, prompt: attributed, clientNonce: delivery.idempotencyKey }));
    const queued = next.finally(() => { if (queues.get(check.targetId) === queued) queues.delete(check.targetId); });
    queues.set(check.targetId, queued);
    void queued;
    return { result: { case: "success", value: { deliveryId: delivery.id, status: "queued", target: check.targetId } } };
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const globalProvider = settings.getInferenceProvider();
      const record = asRecord(args) ?? {};
      if (method === "getBotRoster") return { handled: true, value: parseBotRoster(settings.getBotRoster()) };
      if (method === "upsertBot") {
        const next = upsertBot(parseBotRoster(settings.getBotRoster()), {
          ...(typeof record.id === "string" ? { id: record.id } : {}),
          name: typeof record.name === "string" ? record.name : "",
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(typeof record.description === "string" ? { description: record.description } : {}),
          ...(record.provider === null ? { provider: null } : isSandInferenceProvider(record.provider) ? { provider: record.provider } : {}),
          ...(record.modelId === null ? { modelId: null } : typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
          ...(record.hidden === true || record.hidden === false ? { hidden: record.hidden } : {}),
        });
        settings.setBotRoster(next);
        return { handled: true, value: next };
      }
      if (method === "hideBot") {
        const botId = typeof record.botId === "string" ? record.botId : "";
        const next = hideBot(parseBotRoster(settings.getBotRoster()), botId, record.hidden !== false);
        settings.setBotRoster(next);
        return { handled: true, value: next };
      }
      if (method === "deleteBot") {
        const botId = typeof record.botId === "string" ? record.botId : "";
        const next = deleteBot(parseBotRoster(settings.getBotRoster()), botId);
        settings.setBotRoster(next);
        return { handled: true, value: next };
      }
      if (method === "createBotGroup") {
        const name = typeof record.name === "string" ? record.name : "";
        const memberIds = Array.isArray(record.memberIds) ? record.memberIds.filter((id): id is string => typeof id === "string") : [];
        const next = createBotGroup(parseBotRoster(settings.getBotRoster()), name, memberIds);
        settings.setBotRoster(next);
        return { handled: true, value: next };
      }
      if (method === "messageAgent") {
        const fromBotId = typeof record.fromBotId === "string" ? record.fromBotId : typeof record.agentId === "string" ? record.agentId : "";
        return { handled: true, value: await deliverMessageAgent(fromBotId, record) };
      }
      if (method === "reactToMessage") {
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      const agentIdForProvider = typeof record.agentId === "string" ? record.agentId : typeof record.id === "string" ? record.id : "";
      const provider = agentIdForProvider.length > 0
        ? resolveBotProvider(parseBotRoster(settings.getBotRoster()), agentIdForProvider, globalProvider)
        : globalProvider;
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const agentId = typeof record.id === "string" ? record.id : "";
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), withStore(async store => ({ store, value: store }))]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const entries = [...result.entries, ...(local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry)];
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: entries.slice(-limit) } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, record)).catch(async (error) => {
        const failure = asBotFailure(error);
        const timestampMs = now();
        const content = formatBotFailure(failure.reason, failure.message.replace(/^\[reason:[a-z_]+\]\s*/, ""));
        if (agentId.length > 0) {
          const local = await withStore(async store => ({ store, value: store }));
          const turn = highestTranscriptTurn((local.agents[agentId] ?? []).map(entry => entry.id)) + 1;
          const id = `t${turn}s0`;
          await append(agentId, [{ provider, role: "assistant", content, id, timestampMs }]);
          emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs });
        }
      });
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}
