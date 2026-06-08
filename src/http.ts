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
 * the one call, and tear it down. No session bookkeeping, no sticky routing.
 *
 * This file owns only what an entrypoint should: build the shared store, read
 * the environment, and listen. The app itself (routes, transport, JSON-RPC
 * shapes) lives in app.ts so it stays testable without a live socket.
 */

import { createApp } from "./app.js";
import { log } from "./logger.js";
import { MemoryStore } from "./memoryStore.js";
import type { Store } from "./store.js";

// One process-wide store, shared across every request. Swap MemoryStore for a
// database-backed Store here when deploying.
const store: Store = new MemoryStore();

// Perimeter auth posture. The token authenticates the connection, NOT the
// per-call session (ADR-0001's rejected transport-auth alternative) — so this
// is hardening for going live, not closure of the per-session identity threats
// S1/S2/T1/E1/I1, which stay live by design.
//
// Fail closed on a hosted runtime: Render sets RENDER=1. Booting OPEN there
// would expose register/spam to the whole internet, so refuse rather than
// silently run unauthenticated. Locally (no RENDER) an unset token is allowed
// but warned, so dev stays friction-free without normalising open prod.
const authToken = process.env.MCP_AUTH_TOKEN;
if (!authToken) {
  if (process.env.RENDER) {
    log.error(
      "MCP_AUTH_TOKEN is required on a hosted runtime (RENDER set); refusing to boot open.",
    );
    process.exit(1);
  }
  log.warn(
    "MCP_AUTH_TOKEN unset — /mcp is OPEN (no perimeter auth). Intended for local/dev only.",
  );
}

const app = createApp(store, { authToken });

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  log.info("agent-surface listening", { url: `http://localhost:${PORT}/mcp` });
});
