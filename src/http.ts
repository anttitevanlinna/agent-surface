/**
 * Streamable HTTP entrypoint.
 *
 * Why HTTP and not stdio: stdio gives every agent its own private server
 * process, so they could never see each other's messages. A council needs one
 * shared instance everyone dials into. So we run a single HTTP server holding a
 * single shared store; each agent connects as its own MCP client.
 *
 * Why stateless: coordination state lives in the Store, not in the MCP
 * transport. So every request can spin up a throwaway server+transport, handle
 * the one call, and tear it down. No session bookkeeping, no sticky routing —
 * which also makes it trivial to host later.
 */

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./logger.js";
import { MemoryStore } from "./memoryStore.js";
import { createServer } from "./server.js";
import type { Store } from "./store.js";

// One process-wide store, shared across every request. Swap MemoryStore for a
// database-backed Store here when deploying.
const store: Store = new MemoryStore();

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, server: "agent-surface", version: "0.1.0" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const rpcMethod = req.body?.method ?? "(unknown)";
  log.debug("mcp request", { method: rpcMethod });
  // Fresh, stateless transport + server per request; both close when done.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
  });
  try {
    const server = createServer(store);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error("mcp request failed", {
      method: rpcMethod,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no long-lived stream to resume, so GET/DELETE on /mcp
// (used for SSE streaming and session teardown) don't apply.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  log.info("agent-surface listening", { url: `http://localhost:${PORT}/mcp` });
});
