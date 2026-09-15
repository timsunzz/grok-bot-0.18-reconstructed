import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { createRealIdleWatchdogPolicy } from "../../../internal/scheduling.js";
import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { ROUTED_TURN_TIMEOUT_ERROR_NAME } from "../../../shared/routed-turn-failure.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;
// What the caller controls about the provider request itself: how long it may say nothing at all,
// how to cancel it, and how many times the provider client may retry on its own before the caller
// hears about a failure.
type RoutedRuntime = { readonly signal?: AbortSignal; readonly abortController?: AbortController; readonly maxRetries?: number; readonly idleTimeoutMs?: number };

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  // Usage totals are a local activity record, so a settings write failure must never
  // abort an otherwise successful turn.
  try { new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage); }
  catch {}
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

function providerPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

interface SideChannel<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

// Routed executors expose `usage`, `extendedUsage`, `providerMetadata` and `response` as
// side channels that a caller is free to ignore. Rejecting an ignored promise raises
// `unhandledRejection`, which both the coordinator and the host treat as a process crash,
// so every channel keeps a permanent no-op handler and settles at most once.
function deferred<T>(): SideChannel<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  promise.catch(() => {});
  let settled = false;
  return {
    promise,
    resolve: value => { if (!settled) { settled = true; resolve(value); } },
    reject: error => { if (!settled) { settled = true; reject(error); } },
  };
}

// A consumer that stops reading `fullStream` early (an aborted turn) would otherwise leave
// these channels pending forever, hanging anyone awaiting `response`.
function settleAbandoned(channels: readonly { reject(error: unknown): void }[], reason: string): void {
  const error = new Error(reason);
  for (const channel of channels) channel.reject(error);
}

function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * How long a routed turn may hear nothing at all from its provider. A provider that stops answering
 * without closing its socket leaves the turn pending, and the coordinator runs one routed turn per
 * agent at a time, so a single such turn swallows every later prompt for that agent.
 *
 * What is bounded is silence, not duration: a turn that reasons at length and then works through
 * eight tool steps is working, however long it takes. Anything the provider sends resets the window,
 * down to a reasoning delta, and work running on the provider's behalf suspends it entirely.
 */
const ROUTED_TURN_IDLE_TIMEOUT_MS = 180_000;

// Three minutes of silence is a stalled provider for every model this app routes to today, but that
// is a judgement about providers, not a fact about them, so it is adjustable in the same way the
// model and reasoning effort are.
function configuredIdleTimeoutMs(): number {
  const configured = Number(process.env.SAND_ROUTED_IDLE_TIMEOUT_MS?.trim());
  return Number.isFinite(configured) && configured > 0 ? configured : ROUTED_TURN_IDLE_TIMEOUT_MS;
}

function silenceDuration(idleTimeoutMs: number): string {
  return idleTimeoutMs < 1_000 ? `${Math.round(idleTimeoutMs)}ms` : `${Math.round(idleTimeoutMs / 1_000)}s`;
}

function routedTimeoutError(provider: RoutedProvider, idleTimeoutMs: number): Error {
  const error = new Error(`${provider} stopped responding: Grok Bot gave up on this turn after ${silenceDuration(idleTimeoutMs)} of silence.`);
  // Deliberately not `AbortError` or `TimeoutError`. Those are how a cancelled turn arrives, and a
  // cancelled turn is never retried; this is the transient case the retry exists for.
  error.name = ROUTED_TURN_TIMEOUT_ERROR_NAME;
  return error;
}

type RoutedToolGate = <T>(work: () => Promise<T>) => Promise<T>;
type RoutedIdleWatchdog = {
  readonly expired: Promise<never>;
  /** The provider said something. Restarts the window if one is open. */
  bump(): void;
  /** Whether the turn is now blocked on the provider, which is the only state the window runs in. */
  awaitingProvider(waiting: boolean): void;
  /** Runs work of ours — a plugin call — with the window suspended for its duration. */
  whileWorking: RoutedToolGate;
  /** Called when the stream is dropped before it ended, so the request behind it is closed. */
  abandoned(): void;
  stop(): void;
};

function routedIdleWatchdog(provider: RoutedProvider, runtime: RoutedRuntime): RoutedIdleWatchdog | null {
  const idleMs = runtime.idleTimeoutMs ?? 0;
  const controller = runtime.abortController;
  // With nothing to cancel there is no deadline worth having: abandoning the turn while its request
  // stays open is the leak this set out to close.
  if (controller == null || !(idleMs > 0)) return null;
  const { promise, reject } = Promise.withResolvers<never>();
  promise.catch(() => {});
  const policy = createRealIdleWatchdogPolicy({ name: `routed-turn-${provider}`, idleMs });
  let armed: { kick(): void; dispose(): void } | null = null;
  let waiting = false;
  let working = 0;
  let done = false;
  const disarm = (): void => { armed?.dispose(); armed = null; };
  const stop = (): void => { done = true; disarm(); };
  const expire = (): void => {
    stop();
    const error = routedTimeoutError(provider, idleMs);
    // Aborted so the provider request is closed, and rejected so the caller hears the deadline
    // rather than whatever shape the abort takes on its way back out of the provider client.
    controller.abort(error);
    reject(error);
  };
  /**
   * The window is open only while the turn is blocked on the provider with nothing of its own
   * running. Two things follow from arming it here rather than at construction: a turn that throws
   * while validating its credentials, and a stream nobody ever iterates, both leave no timer behind.
   * And time the consumer spends on a part it has already been handed does not count, nor does a
   * plugin call — cancelling a healthy request because the reader or a tool was slow would be a
   * worse bug than the one this closes.
   */
  const settle = (): void => {
    if (done) return;
    const open = waiting && working === 0;
    if (open === (armed != null)) { armed?.kick(); return; }
    if (open) armed = policy.arm(expire);
    else disarm();
  };
  return {
    expired: promise,
    bump: () => armed?.kick(),
    awaitingProvider: (next) => { waiting = next; settle(); },
    whileWorking: async (work) => {
      working += 1;
      settle();
      try { return await work(); }
      finally { working -= 1; settle(); }
    },
    // The request is this turn's alone, and nothing is reading it any more. `AbortError` rather than
    // the deadline's own name, because a consumer that walked away is a cancellation and a cancelled
    // turn is deliberately never retried.
    abandoned: () => controller.abort(Object.assign(new Error(`Nothing is reading the ${provider} response, so its request was closed.`), { name: "AbortError" })),
    stop,
  };
}

function whileAnswering<T>(source: AsyncIterable<T>, watchdog: RoutedIdleWatchdog | null): AsyncIterable<T> {
  return watchdog == null ? source : guarded(source, watchdog);
}

async function* guarded<T>(source: AsyncIterable<T>, watchdog: RoutedIdleWatchdog): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      const step = iterator.next();
      // The abandoned step keeps running until the abort reaches it, with nobody waiting on it.
      step.catch(() => {});
      watchdog.awaitingProvider(true);
      const result = await Promise.race([step, watchdog.expired]);
      watchdog.awaitingProvider(false);
      if (result.done === true) { ended = true; return; }
      yield result.value;
    }
  } finally {
    watchdog.stop();
    // A stream dropped before it ended is a request nobody is reading, whether the deadline fired or
    // the consumer walked away, so it is cancelled. A stream that ended is not: its request is
    // already closed, and the caller still has `response` and `usage` to await.
    if (!ended) watchdog.abandoned();
    // Deliberately not awaited. A generator suspended on a provider that has gone quiet cannot
    // resume until that request settles, and waiting for it is what the abort above avoids.
    const wound = iterator.return?.();
    wound?.catch(() => {});
  }
}

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, runtime: RoutedRuntime = {}) {
  const credentials = codexCredentials();
  const watchdog = routedIdleWatchdog("codex", runtime);
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const reasoningEffort = configuredCodexReasoningEffort();
  // Codex tool calls are executed inside `streamCodexDirectResponses`; this executor never
  // surfaces tool-call parts on `fullStream`, so advertising tools without an executor could
  // only fail the turn outright. Answering as text is the better degradation.
  const tools = executeTool == null ? undefined : codexTools(definitions);
  const channels = [usage, extendedUsage, metadata, resultResponse];
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(reasoningEffort == null ? {} : { reasoningEffort }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        // Only text and the final result reach `fullStream`, so the transport reports the rest of
        // what it hears — reasoning deltas included — to the deadline directly. Otherwise a model
        // thinking out loud for a few minutes looks exactly like one that has stopped.
        ...(watchdog == null ? {} : { onActivity: watchdog.bump }),
        // A plugin call is the turn working, and the provider says nothing while one runs. Bumping
        // the window would only buy the call the same three minutes the provider gets; suspending it
        // is what lets a slow plugin finish.
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => {
          const call = () => executeTool(selected.source, args, toolCallId);
          return watchdog == null ? await call() : await watchdog.whileWorking(call);
        } }),
        ...(runtime.signal == null ? {} : { signal: runtime.signal }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
      }
    } catch (error) { for (const channel of channels) channel.reject(error); throw error; }
    finally { settleAbandoned(channels, "Codex ended the routed turn before reporting a result."); }
  })();
  return { fullStream: whileAnswering(fullStream, watchdog), response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string, runtime: RoutedRuntime = {}) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const watchdog = routedIdleWatchdog("claude-code", runtime);
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const channels = [usage, extendedUsage, metadata, resultResponse];
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      // This executor yields once, at the end, so every message Claude Code sends on the way there
      // is the only evidence the deadline has that the turn is alive.
      for await (const message of queryClaude({ prompt: providerPrompt(messages), options: { ...(runtime.abortController == null ? {} : { abortController: runtime.abortController }), pathToClaudeCodeExecutable: executable, cwd: getSandRootDir(), tools: mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"], ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }), permissionMode: "default", maxTurns: mcpServerUrl == null ? 1 : 8, persistSession: false, ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }) } })) {
        watchdog?.bump();
        if (message.type === "result") final = message;
      }
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const reported = (final.usage ?? {}) as Loose;
      const tokens = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const input = tokens(reported.input_tokens), output = tokens(reported.output_tokens), cacheRead = tokens(reported.cache_read_input_tokens), cacheWrite = tokens(reported.cache_creation_input_tokens);
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) { for (const channel of channels) channel.reject(error); throw error; }
    finally { settleAbandoned(channels, "Claude Code ended the routed turn before reporting a result."); }
  })();
  return { fullStream: whileAnswering(fullStream, watchdog), response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor, whileWorking?: RoutedToolGate): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    // A rejecting `execute` reaches `streamText` as an error part, which fails the whole turn and
    // discards the answer the model had already streamed. One unreachable plugin is not the end of
    // a turn: the Codex transport and the Claude Code bridge both hand the model an `isError`
    // result and let it carry on, so this one does too.
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => {
      // The SDK emits nothing while a tool runs, so the deadline has to be told that the silence is
      // the turn working rather than the provider stalling.
      const call = async (): Promise<unknown> => {
        try { return await executeTool(definition, args, options.toolCallId); }
        catch (error) { return { isError: true, error: error instanceof Error ? error.message : String(error) }; }
      };
      return whileWorking == null ? await call() : await whileWorking(call);
    };
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, runtime: RoutedRuntime = {}) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id as any);
  const watchdog = routedIdleWatchdog("openrouter", runtime);
  const tools = toToolSet(definitions, executeTool, watchdog?.whileWorking);
  // `maxRetries` is the caller's to set. The AI SDK retries 429s and 5xx twice of its own accord,
  // and a routed turn has its own retry that paces itself from `Retry-After`; leaving both on
  // spends up to six provider requests on one rate-limited turn, three of them back to back
  // before any header is read.
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8, maxRetries: runtime.maxRetries ?? 2, ...(runtime.signal == null ? {} : { abortSignal: runtime.signal }) });
  const extendedUsage = observed(result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 })));
  if (onUsage != null) void extendedUsage.then(onUsage, () => {});
  return { fullStream: whileAnswering(result.fullStream, watchdog), response: observed(result.response), usage: observed(result.usage), extendedUsage, providerMetadata: observed(result.providerMetadata), invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    // The host's agent turns come through here rather than through `runRoutedProviderText`, and a
    // provider that goes quiet strands them just as thoroughly. Nothing retries at this level, so
    // the provider client keeps its own retries; only the deadline is shared.
    const abortController = new AbortController();
    const runtime: RoutedRuntime = { signal: abortController.signal, abortController, idleTimeoutMs: configuredIdleTimeoutMs() };
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, runtime);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage, undefined, runtime);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, runtime);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly idleTimeoutMs?: number;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const abortController = new AbortController();
  // The router owns the retry for these turns, and paces it from the provider's `Retry-After`, so
  // the provider client must not quietly retry underneath it.
  const runtime: RoutedRuntime = { signal: abortController.signal, abortController, maxRetries: 0, idleTimeoutMs: options?.idleTimeoutMs ?? configuredIdleTimeoutMs() };
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, runtime)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl, runtime)
      : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, runtime);
  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
      continue;
    }
    // The AI SDK reports a refused request as a stream part and then leaves `response` pending, so
    // a turn that only awaited the promise waited out the whole deadline for a failure the provider
    // had already stated. Raising it here is also what lets the router see the status and
    // `Retry-After` the provider sent.
    if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
  }
  // Every transport settles this when its stream ends, whether or not it produced a result, so the
  // deadline guarding the stream is enough to cover the wait.
  await result.response;
  return text;
}
