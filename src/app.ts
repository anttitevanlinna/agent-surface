/**
 * The Express app, built but NOT listening.
 *
 * Why split this out of http.ts: an app you can `createApp(store)` and hand to
 * `supertest`/`app.listen(0)` is testable; an app that calls `listen()` at
 * import time is not. So this module owns *wiring* (routes, transport, the
 * JSON-RPC shapes) and stays silent about *where* it runs — the entrypoint
 * (http.ts) owns the port, signals, and boot posture.
 *
 * Statelessness is unchanged from the original entrypoint: one shared store, a
 * throwaway transport+server per request. `enableJsonResponse: true` makes the
 * transport answer a request/response call (like `initialize`) with a JSON body
 * instead of opening an SSE stream — which is what a plain JSON-RPC client, and
 * our tests, expect.
 */

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";
import type { Store } from "./store.js";

export function createApp(store: Store) {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, server: "agent-surface", version: "0.1.0" });
  });

  app.post("/mcp", express.json(), async (req: Request, res: Response) => {
    const rpcMethod = req.body?.method ?? "(unknown)";
    log.debug("mcp request", { method: rpcMethod });
    // Fresh, stateless transport + server per request; both close when done.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
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

  return app;
}
