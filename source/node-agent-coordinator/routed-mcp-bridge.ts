import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

type Tool = {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, any> : null;
}

function isReadOnly(tool: Tool): boolean {
  const toolName = tool.toolName.toLowerCase();
  const label = `${tool.name} ${tool.toolName} ${tool.description ?? ""}`.toLowerCase();
  if (/(send|create|update|delete|remove|write|upload|post|reply|archive|move|rename|modify|cancel|purchase|buy|forward)/.test(label)) return false;
  return /^(read|list|get|search|find|fetch|query|lookup|inspect|view|download|retrieve)(_|$)/.test(toolName);
}

function mcpResult(value: unknown): Record<string, unknown> {
  const root = record(value);
  const result = record(root?.result);
  if (result?.case !== "success") {
    const detail = record(result?.value);
    return { isError: true, content: [{ type: "text", text: typeof detail?.error === "string" ? detail.error : JSON.stringify(value) }] };
  }
  const success = record(result.value);
  const content: Record<string, unknown>[] = Array.isArray(success?.content) ? success.content.flatMap((raw: unknown): Record<string, unknown>[] => {
    const item = record(raw), carrier = record(item?.content), payload = record(carrier?.value);
    if (carrier?.case === "text" && typeof payload?.text === "string") return [{ type: "text", text: payload.text }];
    if (carrier?.case === "image" && payload?.data != null && typeof payload?.mimeType === "string") return [{ type: "image", data: payload.data, mimeType: payload.mimeType }];
    return [];
  }) : [];
  return { isError: success?.isError === true, content: content.length === 0 ? [{ type: "text", text: JSON.stringify(success ?? value) }] : content, ...(success?.structuredContent == null ? {} : { structuredContent: success.structuredContent }) };
}

export function parseRoutedToolArguments(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    const object = record(parsed);
    if (object == null) throw new Error("Tool arguments must be a JSON object.");
    return object;
  }
  const object = record(value);
  if (object == null) throw new Error("Tool arguments must be a JSON object.");
  return object;
}

export function routedToolCallId(params: Record<string, unknown> | null, name: string, args: unknown): string {
  const explicit = params?.toolCallId;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const meta = record(params?._meta);
  if (typeof meta?.progressToken === "string" && meta.progressToken.length > 0) return meta.progressToken;
  return createHash("sha256").update(`${name}\0${JSON.stringify(args)}`).digest("hex").slice(0, 32);
}

export async function createRoutedMcpBridge(deps: {
  readonly listTools: () => Promise<unknown>;
  readonly callTool: (args: Tool & { readonly args: unknown; readonly toolCallId: string }) => Promise<unknown>;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const secret = randomUUID();
  let tools = new Map<string, Tool>();
  let listed = false;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== `/mcp/${secret}`) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_048_576) { response.writeHead(413).end(); return; }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    let message: Record<string, any>;
    try { message = JSON.parse(body) as Record<string, any>; }
    catch { response.writeHead(400).end(); return; }
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    const reply = (result: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    try {
      if (message.method === "initialize") { reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "grok-bot-plugins", version: "1" } }); return; }
      if (message.method === "tools/list") {
        const discovered = await deps.listTools();
        const rows = Array.isArray(discovered) ? discovered : [];
        tools = new Map(rows.flatMap(raw => {
          const row = record(raw);
          if (typeof row?.name !== "string" || typeof row.providerIdentifier !== "string" || typeof row.toolName !== "string") return [];
          return [[row.name, row as Tool]];
        }));
        listed = true;
        reply({ tools: [...tools.values()].map(tool => {
          const readOnly = isReadOnly(tool);
          return { name: tool.name, description: tool.description ?? `${tool.toolName} via ${tool.providerIdentifier}`, inputSchema: record(tool.inputSchema) ?? { type: "object", additionalProperties: true }, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly } };
        }) });
        return;
      }
      if (message.method === "tools/call") {
        if (!listed) { reply({ isError: true, content: [{ type: "text", text: "Grok Bot plugin tools are not listed yet." }] }); return; }
        const params = record(message.params);
        const name = params?.name, selected = typeof name === "string" ? tools.get(name) : undefined;
        if (selected == null) { reply({ isError: true, content: [{ type: "text", text: `Unknown Grok Bot plugin tool: ${String(name)}` }] }); return; }
        let args: Record<string, unknown>;
        try { args = parseRoutedToolArguments(params?.arguments); }
        catch (error) { reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }); return; }
        reply(mcpResult(await deps.callTool({ ...selected, args, toolCallId: routedToolCallId(params, selected.name, args) })));
        return;
      }
      reply({});
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the routed MCP bridge");
  return { url: `http://127.0.0.1:${address.port}/mcp/${secret}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error == null ? resolve() : reject(error)); }) };
}
