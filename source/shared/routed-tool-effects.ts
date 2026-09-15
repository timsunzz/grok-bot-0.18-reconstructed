// Routed plugin tools reach a provider over two different transports: an MCP bridge for Claude
// Code, and a plain tool list for Codex and OpenRouter. Both transports need the same answer to
// "could replaying this call change anything?" — the bridge to annotate what it advertises, the
// router to decide whether a failed turn may be retried — so the rule lives here instead of
// being decided twice.

type ToolLabel = { readonly name?: unknown; readonly toolName?: unknown; readonly description?: unknown };

function label(tool: ToolLabel): string {
  return [tool.name, tool.toolName, tool.description].filter(part => typeof part === "string").join(" ").toLowerCase();
}

export function routedToolIsReadOnly(tool: ToolLabel): boolean {
  const text = label(tool);
  return /(^|[^a-z])(read|search|find|list|get|fetch|query|lookup|inspect|view|download|retrieve)([^a-z]|$)/.test(text)
    && !/(send|create|update|delete|remove|write|upload|post|reply|archive|move|rename|modify|cancel|purchase|buy)/.test(text);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// `executeRoutedMcpTool` answers with the host's tool-result envelope: a `result` oneof whose
// `success` case can still carry the plugin's own `isError`. Both shapes mean the call did not
// do what the model asked, which is what the breaker counts.
export function routedToolCallFailed(value: unknown): boolean {
  const result = record(record(value)?.result);
  if (result?.case !== "success") return true;
  return record(result.value)?.isError === true;
}
