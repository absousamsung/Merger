// /mcp — MCP over Streamable HTTP, STATELESS mode: fresh McpServer +
// WebStandardStreamableHTTPServerTransport per request (sessionIdGenerator:
// undefined). The web-standard transport consumes a Request and returns a
// Response directly — a perfect fit for Next.js App Router route handlers, and
// no session affinity is needed (all state lives in Turso; spec 4/7).
import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, KNOWN_TOOLS, UNKNOWN_TOOL_MSG } from "@/lib/mcpServer";
import { mcpAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACCEPT = "application/json, text/event-stream";

function jsonError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", Accept: ACCEPT },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "غير مصرح — مطلوب MCP_ACCESS_TOKEN" }), {
    status: 401,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handle(request: Request, parsedBody: unknown): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    // The transport resolves before its SSE stream finishes, so teardown must
    // wait until the response body is fully drained — otherwise in-flight
    // progress streams get truncated.
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    const body = response.body
      ? response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush: teardown,
          })
        )
      : null;
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), scope: "mcp", error: String((err as Error).message || err) }));
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
    return jsonError(500, -32603, "Internal server error");
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!mcpAuthorized(request.headers.get("authorization"))) return unauthorized();
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonError(400, -32700, "Parse error");
  }
  if (raw.length > 1024 * 1024) {
    return jsonError(413, -32700, "Request body too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError(400, -32700, "Parse error: invalid JSON");
  }
  const body = parsed as { method?: string; params?: { name?: string } };
  if (body.method === "tools/call" && typeof body.params?.name === "string" && !KNOWN_TOOLS.includes(body.params.name as (typeof KNOWN_TOOLS)[number])) {
    // Arabic fallback for unknown tools (spec 7.4), delivered as a tool result.
    const toolResult = {
      jsonrpc: "2.0",
      id: (parsed as { id?: unknown }).id ?? null,
      result: { content: [{ type: "text", text: UNKNOWN_TOOL_MSG(body.params.name) }], isError: true },
    };
    return new Response(JSON.stringify(toolResult), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return handle(request, parsed);
}

// Stateless mode has no server-initiated SSE listening stream; the transport
// answers GET/DELETE with the protocol-correct 405.
export async function GET(request: NextRequest): Promise<Response> {
  if (!mcpAuthorized(request.headers.get("authorization"))) return unauthorized();
  return handle(request, undefined);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!mcpAuthorized(request.headers.get("authorization"))) return unauthorized();
  return handle(request, undefined);
}
