import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { routedToolCallFailed, routedToolIsReadOnly } from "../shared/routed-tool-effects.js";
import { classifyRoutedTurnFailure, formatRoutedTurnFailure, isRoutedTurnFailureReason, routedTurnRetryDelayMs, routedTurnRetryPolicy, type RoutedTurnFailureReason } from "../shared/routed-turn-failure.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";
import { createRoutedToolBreaker } from "./routed-tool-breaker.js";

const TURN_ID_PATTERN = /^t(\d+)(?:u|s\d+)$/;

type StoredEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  // Present only on a reply that is a failure, and then it is the classification. It is what makes
  // "this prompt was answered" answerable — the alternative is reading the sentence — and a
  // surface can branch on it without parsing prose.
  readonly failureReason?: RoutedTurnFailureReason;
  readonly timestampMs: number;
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

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
      if (row.failureReason !== undefined && !isRoutedTurnFailureReason(row.failureReason)) continue;
      entries.push(row as unknown as StoredEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) }
    : { kind: "send-message", id: entry.id, message: { type: "text", content: entry.content }, timestampMs: entry.timestampMs, ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }), ...(entry.failureReason === undefined ? {} : { failureReason: entry.failureReason }) };
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
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => {
    const current = await load();
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    await persist(next);
    return next;
  };
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  const highestTurn = (ids: readonly string[]): number => ids.reduce((highest, id) => {
    const match = TURN_ID_PATTERN.exec(id);
    return match?.[1] == null ? highest : Math.max(highest, Number(match[1]));
  }, -1);
  // Turn numbers order the local routed transcript against the remote one, so they have to
  // stay small and monotonic. A failed transcript fetch falls back to local numbering rather
  // than failing the turn, because the local store already records our own entries.
  const nextTurn = async (agentId: string): Promise<{ readonly turn: number; readonly store: Store }> => {
    const [remote, store] = await Promise.all([
      options.dispatchRemote("getAgentTranscriptTail", { id: agentId }).catch(() => null),
      load(),
    ]);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteIds = remoteEntries.flatMap(raw => { const id = asRecord(raw)?.id; return typeof id === "string" ? [id] : []; });
    const turn = Math.max(highestTurn(remoteIds), highestTurn((store.agents[agentId] ?? []).map(entry => entry.id))) + 1;
    return { turn, store };
  };
  // The turn of the newest prompt that has no reply, so a failure reported from outside `execute`
  // can be filed against the prompt it belongs to. Without this the reply lands a turn ahead of
  // its prompt whenever the prompt was already appended, which is every failure between appending
  // the prompt and starting the provider request.
  const unansweredTurn = async (agentId: string, fallbackTurn: number): Promise<number> => {
    const entries = (await load().catch(() => EMPTY_STORE)).agents[agentId] ?? [];
    const answered = new Set(entries.flatMap(entry => entry.role === "assistant" ? [TURN_ID_PATTERN.exec(entry.id)?.[1] ?? ""] : []));
    const pending = entries.flatMap(entry => {
      const turn = entry.role === "user" ? TURN_ID_PATTERN.exec(entry.id)?.[1] : undefined;
      return turn != null && !answered.has(turn) ? [Number(turn)] : [];
    });
    return pending.length === 0 ? fallbackTurn : Math.max(...pending);
  };
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
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return null;
    const before = entries[index]!;
    const reactions = before.reactions ?? [];
    const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
    const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
    const { reactions: _oldReactions, ...withoutReactions } = before;
    const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
    const nextEntries = [...entries];
    nextEntries[index] = updated;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
    return projectInferenceRouterTranscriptEntry(updated);
  };
  const execute = async (provider: Exclude<SandInferenceProvider, "cursor">, args: Record<string, unknown>) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) throw new Error("Local inference routing requires an agentId and prompt");
    const timestampMs = now();
    const { turn, store: beforeUser } = await nextTurn(agentId);
    // A resubmitted prompt carries the nonce of the submission it repeats. Replaying it would
    // duplicate the turn, so a prompt that was already answered under this nonce is acknowledged
    // without running again. A reused nonce carrying different text still runs: dropping a real
    // message would be worse than an extra turn.
    //
    // "Answered" is the part that matters. A prompt whose turn failed is recorded too, and
    // resending it is how a person retries — the desktop's `resendFailed` reuses the nonce — so a
    // guard that only looked for the prompt refused to run the turn a second time and said nothing
    // about why.
    const existing = beforeUser.agents[agentId] ?? [];
    const repeated = existing.filter(entry => entry.role === "user" && entry.clientNonce === clientNonce && entry.content === prompt);
    const answered = repeated.some(entry => {
      const repeatedTurn = TURN_ID_PATTERN.exec(entry.id)?.[1];
      return repeatedTurn != null && existing.some(reply => reply.role === "assistant" && reply.id === `t${repeatedTurn}s0` && reply.failureReason === undefined);
    });
    if (answered) return { accepted: true, clientNonce, provider };
    const userEntry = { kind: "message", id: `t${turn}u`, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    const withUser = await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);
    // Everything from here on runs inside the activity pulse, so everything from here on has to be
    // inside the block that clears it. Bringing up the tool bridge and listing the plugins are both
    // remote calls that can fail, and each one used to leave the agent row composing for the rest of
    // the session.
    const endActivity = await beginActivity(agentId);
    let bridge: Awaited<ReturnType<typeof createRoutedMcpBridge>> | null = null;
    try {
      // The shipped transcript intentionally suppresses its activity row as soon as
      // the first streamed assistant entry arrives. Direct providers can produce that
      // first delta in the same renderer reconciliation window as the roster update,
      // making the genuine composing state imperceptible. The shipped virtualized
      // transcript needs roughly 350 ms to materialize its trailing activity row,
      // so keep the composing state authoritative long enough for a clearly
      // perceptible rendered interval before normal token streaming begins.
      await new Promise<void>(resolve => setTimeout(resolve, 1_200));
      const messages = (withUser.agents[agentId] ?? []).map(entry => ({ role: entry.role, content: entry.content }));
      let content: string;
      const assistantTimestampMs = now();
      const assistantId = `t${turn}s0`;
      let assistantStreamStarted = false;
      const emitAssistant = (nextContent: string, streaming: boolean, failureReason?: RoutedTurnFailureReason) => {
        const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs, ...(failureReason === undefined ? {} : { failureReason }) };
        emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
        assistantStreamStarted = true;
      };
      // Every routed tool call funnels through here, whichever transport carries it, so the
      // breaker and the retry gate see one accounting of what this turn has already done.
      const breaker = createRoutedToolBreaker();
      let appliedWriteEffect = false;
      const callRoutedTool = async (definition: Record<string, any>, toolArgs: unknown, toolCallId: string): Promise<unknown> => {
        const server = typeof definition.providerIdentifier === "string" ? definition.providerIdentifier : "";
        const refusal = breaker.refusal(server);
        if (refusal != null) return { result: { case: "error", value: { error: refusal } } };
        // Marked before dispatching, not after: a write whose transport died on the way back may
        // still have landed, and that is exactly the case a retry must not replay.
        if (!routedToolIsReadOnly(definition)) appliedWriteEffect = true;
        let value: unknown;
        try {
          value = await options.dispatchRemote("executeRoutedMcpTool", {
            providerIdentifier: definition.providerIdentifier,
            name: definition.name,
            toolName: definition.toolName,
            args: toolArgs,
            toolCallId,
            agentId,
          });
        } catch (error) { breaker.recordFailure(server, "unreachable"); throw error; }
        if (routedToolCallFailed(value)) breaker.recordFailure(server, "rejected");
        else breaker.recordSuccess(server);
        return value;
      };
      bridge = provider === "claude-code" ? await createRoutedMcpBridge({
        listTools: () => options.dispatchRemote("listRoutedMcpTools", {}),
        callTool: tool => callRoutedTool(tool, tool.args, tool.toolCallId),
      }) : null;
      const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}) : undefined;
      const tools = Array.isArray(directTools) ? directTools as Record<string, any>[] : undefined;
      const onTextDelta = (_delta: string, accumulated: string) => emitAssistant(accumulated, true);
      const mcpServerUrl = bridge?.url;
      const attempt = () => runRoutedProviderText(provider, messages, mcpServerUrl == null ? {
        ...(tools === undefined ? {} : { tools }),
        executeTool: callRoutedTool,
        onTextDelta,
      } : { mcpServerUrl, onTextDelta });
      try {
        try { content = await attempt(); }
        catch (error) {
          // One retry, and only for classes a retry can actually fix on a turn that has not
          // already changed something. The same turn resumes; a retried turn never mints a new
          // one, and its assistant entry is rewritten rather than appended twice.
          if (routedTurnRetryPolicy(classifyRoutedTurnFailure(error), { appliedWriteEffect }) !== "resume") throw error;
          const delayMs = routedTurnRetryDelayMs(error);
          if (delayMs == null) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          content = await attempt();
        }
      } catch (error) {
        // Reported here rather than by the caller so the failure keeps this turn's own id
        // instead of inventing one.
        const reason = classifyRoutedTurnFailure(error);
        const failure = formatRoutedTurnFailure(error, reason, { appliedWriteEffect });
        await append(agentId, [{ provider, role: "assistant", content: failure, id: assistantId, failureReason: reason, timestampMs: assistantTimestampMs }]);
        emitAssistant(failure, false, reason);
        return { accepted: true, clientNonce, provider };
      }
      await append(agentId, [{ provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs }]);
      emitAssistant(content, false);
      return { accepted: true, clientNonce, provider };
    } finally {
      // Neither of these may replace what the turn is already reporting on its way out, and either
      // can fail synchronously as well as asynchronously.
      try { endActivity(); } catch {}
      try { await bridge?.close(); } catch {}
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
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), load()]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const entries = [...result.entries, ...(local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry)];
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: entries.slice(-limit) } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, record)).catch(async (error) => {
        const timestampMs = now();
        const reason = classifyRoutedTurnFailure(error);
        const content = formatRoutedTurnFailure(error, reason);
        if (agentId.length === 0) return;
        // `execute` can fail after recording the prompt — bringing up the tool bridge, listing
        // tools, a store write — and then the reply belongs to that prompt's turn, not to the next
        // one. A turn ahead of its prompt leaves the prompt looking permanently unanswered.
        const fallbackTurn = await nextTurn(agentId).then(result => result.turn).catch(() => 0);
        const id = `t${await unansweredTurn(agentId, fallbackTurn)}s0`;
        await append(agentId, [{ provider, role: "assistant", content, id, failureReason: reason, timestampMs }]);
        emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, failureReason: reason, timestampMs });
      });
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}
