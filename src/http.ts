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

const app = createApp(store);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  log.info("agent-surface listening", { url: `http://localhost:${PORT}/mcp` });
});
