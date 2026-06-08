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

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearer } from "./auth.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";
import type { Store } from "./store.js";

export interface CreateAppOptions {
  /**
   * Shared-secret perimeter token. When set, every /mcp route (POST and the
   * 405 GET/DELETE) requires `Authorization: Bearer <token>`. When omitted,
   * /mcp is OPEN — the entrypoint decides whether that is allowed (it is not on
   * a hosted runtime; see http.ts fail-closed boot). /health is never gated.
   */
  authToken?: string;
}

export function createApp(store: Store, opts: CreateAppOptions = {}) {
  const app = express();

  // Perimeter gate, mounted BEFORE the body parser so an unauthenticated
  // oversized body never reaches the parser. Empty when no token is configured
  // (open mode). Spreads cleanly into each route's middleware chain.
  const gate = opts.authToken ? [requireBearer(opts.authToken)] : [];

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, server: "agent-surface", version: "0.1.0" });
  });

  // Body cap mounted AFTER the gate (above): an unauthenticated oversized body
  // is rejected at the gate and never reaches this parser. 256kb is generous for
  // a JSON-RPC coordination call yet bounds a trivial memory-exhaustion vector.
  app.post("/mcp", ...gate, express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
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
  app.get("/mcp", ...gate, methodNotAllowed);
  app.delete("/mcp", ...gate, methodNotAllowed);

  // Terminal JSON-RPC error handler. express.json() throws a 413 for an
  // over-limit body and a 400 for malformed JSON; by default finalhandler would
  // answer those as HTML. Reshape them into the SAME JSON-RPC envelope as the
  // 401/405 so every rejection a client meets is one parseable shape, never HTML.
  app.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      if (res.headersSent) return next(err);
      const e = err as { type?: string; status?: number; statusCode?: number };
      const status = e?.status ?? e?.statusCode;
      if (e?.type === "entity.too.large" || status === 413) {
        res.status(413).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Request body exceeds 256kb limit." },
          id: null,
        });
        return;
      }
      if (e?.type === "entity.parse.failed" || status === 400) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: invalid JSON body." },
          id: null,
        });
        return;
      }
      log.error("unhandled app error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    },
  );

  return app;
}
