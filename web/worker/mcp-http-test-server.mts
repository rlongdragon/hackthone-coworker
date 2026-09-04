// Throwaway HTTP (Streamable) MCP server for testing the http import path.
// Stateless mode (no session id). Listens on MCP_HTTP_PORT (default 39555) at
// /mcp. Two tools: a read-only echo and a side-effecting create_ticket.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.MCP_HTTP_PORT ?? 39555);

function buildServer(): McpServer {
  const s = new McpServer({ name: "http-test-mcp", version: "1.0.0" });
  s.registerTool(
    "http_echo",
    {
      description: "Echo the given text back to the caller. Read-only, no side effects.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `http-echo: ${text}` }] }),
  );
  s.registerTool(
    "create_ticket",
    {
      description: "Create a support ticket.",
      inputSchema: { title: z.string() },
    },
    async ({ title }) => ({ content: [{ type: "text", text: `ticket: ${title}` }] }),
  );
  return s;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  // Stateless: a fresh server + transport per request (SDK-recommended pattern).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`http-test-mcp listening on http://127.0.0.1:${PORT}/mcp`);
});
