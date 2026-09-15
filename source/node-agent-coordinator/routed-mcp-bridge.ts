import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { routedToolIsReadOnly } from "../shared/routed-tool-effects.js";

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

const MAX_BODY_BYTES = 1_048_576;

export async function createRoutedMcpBridge(deps: {
  readonly listTools: () => Promise<unknown>;
  readonly callTool: (args: Tool & { readonly args: unknown; readonly toolCallId: string }) => Promise<unknown>;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const secret = randomUUID();
  let tools = new Map<string, Tool>();
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST" || request.url !== `/mcp/${secret}`) { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      // Stop the upload as well as refusing it; otherwise the sender keeps filling a socket whose
      // request nobody is reading any more.
      if (body.length > MAX_BODY_BYTES) { response.writeHead(413).end(); request.destroy(); return; }
    }
    let message: Record<string, any>;
    try { message = JSON.parse(body) as Record<string, any>; }
    catch { response.writeHead(400).end(); return; }
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    // A handler that both replies and then fails would otherwise write after end, which throws
    // over whatever the original failure was.
    let replied = false;
    const reply = (result: unknown) => { if (replied) return; replied = true; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
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
        reply({ tools: [...tools.values()].map(tool => {
          const readOnly = routedToolIsReadOnly(tool);
          return { name: tool.name, description: tool.description ?? `${tool.toolName} via ${tool.providerIdentifier}`, inputSchema: record(tool.inputSchema) ?? { type: "object", additionalProperties: true }, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly } };
        }) });
        return;
      }
      if (message.method === "tools/call") {
        const name = record(message.params)?.name, selected = typeof name === "string" ? tools.get(name) : undefined;
        if (selected == null) { reply({ isError: true, content: [{ type: "text", text: `Unknown Grok Bot plugin tool: ${String(name)}` }] }); return; }
        reply(mcpResult(await deps.callTool({ ...selected, args: record(message.params)?.arguments ?? {}, toolCallId: randomUUID() })));
        return;
      }
      reply({});
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    }
  };
  const server = createServer((request, response) => {
    // A client that disconnects mid-upload rejects the request iterator, and the coordinator exits
    // on `unhandledRejection`, so one abandoned tool call used to take the whole process down.
    // Whatever went wrong, this connection is the only casualty.
    void serve(request, response).catch(() => {
      if (response.writableEnded) return;
      try { response.writeHead(500).end(); } catch { response.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the routed MCP bridge");
  return { url: `http://127.0.0.1:${address.port}/mcp/${secret}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error == null ? resolve() : reject(error)); }) };
}
