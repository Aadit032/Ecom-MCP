#!/usr/bin/env bun
/**
 * Express + MCP Streamable HTTP entry.
 *
 * Clients connect at /mcp. Synthetic refund investigation & approval tools only
 *
 * Env: PORT (default 3000), HOST (default 0.0.0.0)
 */
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createRefundMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "./src/create-server.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = createMcpExpressApp({ host: HOST });

const mcpHandler = createMcpHandler(() => createRefundMcpServer(), {
  onerror: (err) => console.error("[mcp]", err)
});

const nodeMcp = toNodeHandler(mcpHandler, {
  onerror: (err) => console.error("[mcp-http]", err)
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "streamable-http",
  });
});

// Streamable HTTP (POST tools/initialize, GET SSE, DELETE session).
app.all("/mcp", async (req, res) => {
  await nodeMcp(req, res, req.body);
});

app.listen(PORT, HOST, () => {
  console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${HOST}:${PORT}`,);
  console.error(`  MCP endpoint:  http://${HOST}:${PORT}/mcp`);
  console.error(`  Health check:  http://${HOST}:${PORT}/health`);
});