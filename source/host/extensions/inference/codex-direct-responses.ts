type Loose = Record<string, any>;

export type CodexDirectUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type CodexDirectTool = {
  readonly name: string;
  readonly description?: string;
  readonly parameters: unknown;
  readonly source: Loose;
};

export type CodexDirectEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "done"; readonly text: string; readonly responseId: string; readonly usage: CodexDirectUsage };

export type CodexDirectOptions = {
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly model: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly instructions: string;
  readonly input: readonly Loose[];
  readonly tools?: readonly CodexDirectTool[];
  readonly executeTool?: (tool: CodexDirectTool, args: unknown, toolCallId: string) => Promise<unknown>;
  readonly maxSteps?: number;
};

function record(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null"; }
  catch (error) { return JSON.stringify({ isError: true, error: error instanceof Error ? error.message : String(error) }); }
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  try { detail = (await response.text()).slice(0, 4_096).trim(); } catch {}
  return new Error(`Codex direct request failed (${response.status}${detail.length === 0 ? "" : `: ${detail}`}).`);
}

function nextSseBoundary(buffer: string): { readonly index: number; readonly size: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { index: lf, size: 2 };
  if (lf === -1) return { index: crlf, size: 4 };
  return crlf < lf ? { index: crlf, size: 4 } : { index: lf, size: 2 };
}

export function splitSseBlocks(buffer: string): { readonly blocks: string[]; readonly rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let boundary = nextSseBoundary(rest);
  while (boundary != null) {
    blocks.push(rest.slice(0, boundary.index).replaceAll("\r", ""));
    rest = rest.slice(boundary.index + boundary.size);
    boundary = nextSseBoundary(rest);
  }
  return { blocks, rest };
}

async function* sseEvents(response: Response): AsyncGenerator<Loose> {
  if (response.body == null) throw new Error("Codex direct response did not include a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const split = splitSseBlocks(buffer);
      buffer = split.rest;
      for (const block of split.blocks) {
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data.length === 0 || data === "[DONE]") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); }
        catch { throw new Error("Codex direct response contained malformed SSE JSON."); }
        const event = record(parsed);
        if (event != null) yield event;
      }
      if (done) break;
    }
    if (buffer.trim().length > 0 && buffer.trim() !== "data: [DONE]" && buffer.trim() !== "data: [DONE]\r") {
      throw new Error("Codex direct response ended with an incomplete SSE event.");
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

function finiteCount(value: unknown): number {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function usageOf(response: Loose): CodexDirectUsage {
  const usage = record(response.usage) ?? {};
  const details = record(usage.input_tokens_details) ?? {};
  return {
    inputTokens: finiteCount(usage.input_tokens),
    outputTokens: finiteCount(usage.output_tokens),
    cacheReadTokens: finiteCount(details.cached_tokens),
    cacheWriteTokens: 0,
  };
}

function addUsage(total: CodexDirectUsage, next: CodexDirectUsage): CodexDirectUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  };
}

function toolCalls(output: readonly unknown[]): Loose[] {
  return output.flatMap(item => {
    const call = record(item);
    return call?.type === "function_call" && typeof call.name === "string" && typeof call.call_id === "string" ? [call] : [];
  });
}

function requestTools(tools: readonly CodexDirectTool[] | undefined): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    ...(tool.description == null ? {} : { description: tool.description }),
    parameters: tool.parameters,
    strict: false,
  }));
}

export async function* streamCodexDirectResponses(options: CodexDirectOptions): AsyncGenerator<CodexDirectEvent> {
  const maxSteps = options.maxSteps ?? 8;
  const toolsByName = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  let input: Loose[] = options.input.map(item => ({ ...item }));
  let text = "";
  let responseId = "";
  let usage: CodexDirectUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    const declaredTools = requestTools(options.tools);
    const response = await options.fetch(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "user-agent": "grok-bot-router/1" },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        input,
        ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto", parallel_tool_calls: true }),
        ...(options.reasoningEffort == null ? {} : { reasoning: { effort: options.reasoningEffort, summary: "auto" } }),
        include: ["reasoning.encrypted_content"],
        stream: true,
        store: false,
      }),
    });
    if (!response.ok) throw await responseError(response);

    let completed: Loose | null = null;
    const observedOutput: Loose[] = [];
    for await (const event of sseEvents(response)) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        yield { type: "text-delta", delta: event.delta };
      } else if (event.type === "response.output_item.done") {
        const item = record(event.item);
        if (item != null) observedOutput.push(item);
      } else if (event.type === "response.completed") {
        completed = record(event.response);
      } else if (event.type === "response.failed" || event.type === "error") {
        const failure = record(event.response)?.error ?? event.error ?? event;
        throw new Error(`Codex direct response failed: ${safeJson(failure).slice(0, 4_096)}`);
      }
    }
    if (completed == null) throw new Error("Codex direct response ended without response.completed.");
    if (typeof completed.id === "string") responseId = completed.id;
    usage = addUsage(usage, usageOf(completed));
    const output = Array.isArray(completed.output) && completed.output.length > 0 ? completed.output : observedOutput;
    const calls = toolCalls(output);
    if (calls.length === 0) {
      yield { type: "done", text, responseId, usage };
      return;
    }
    if (options.executeTool == null) throw new Error("Codex requested a tool but Grok Bot did not provide an executor.");

    const results: Loose[] = [];
    for (const call of calls) {
      const selected = toolsByName.get(call.name);
      if (selected == null) {
        results.push({ type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: `Unknown Grok Bot tool: ${call.name}` }) });
        continue;
      }
      let args: unknown = {};
      try { args = typeof call.arguments === "string" && call.arguments.length > 0 ? JSON.parse(call.arguments) : {}; }
      catch { results.push({ type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: "Tool arguments were not valid JSON." }) }); continue; }
      try {
        results.push({ type: "function_call_output", call_id: call.call_id, output: safeJson(await options.executeTool(selected, args, call.call_id)) });
      } catch (error) {
        results.push({ type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: error instanceof Error ? error.message : String(error) }) });
      }
    }
    input = [...input, ...output.flatMap(item => {
      const row = record(item);
      return row == null ? [] : [row];
    }), ...results];
  }
  throw new Error(`Codex exceeded Grok Bot's ${maxSteps}-step tool limit.`);
}
