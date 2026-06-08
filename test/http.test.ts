/**
 * HTTP-entrypoint tests: boot the REAL Express app (createApp) on an ephemeral
 * port and drive it with real `fetch`. This is the layer server.test.ts
 * deliberately skips — nothing here crosses the in-memory transport; it all goes
 * over a real socket, which is the whole point (test-strategy: "the transport
 * differs").
 *
 * MCP Streamable-HTTP requires a dual Accept header
 * (`application/json, text/event-stream`) and `Content-Type: application/json`;
 * with `enableJsonResponse` the server answers `initialize` with a JSON body.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MemoryStore } from "../src/memoryStore.ts";
import { createApp } from "../src/app.ts";

process.env.LOG_LEVEL = "silent";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** A minimal, valid JSON-RPC `initialize` request body. */
function initializeBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.0.0" },
      ...extra,
    },
  });
}

/** Boot a createApp(...) instance on port 0; return base URL + a stop(). */
async function boot(app: ReturnType<typeof createApp>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("Given the app built by createApp (no auth token)", () => {
  let base: string;
  let stop: () => Promise<void>;

  before(async () => {
    ({ base, stop } = await boot(createApp(new MemoryStore())));
  });
  after(() => stop());

  describe("When GET /health is requested", () => {
    it("Then it returns 200", async () => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; server: string };
      assert.equal(body.ok, true);
      assert.equal(body.server, "agent-surface");
    });
  });

  describe("When initialize is POSTed to /mcp", () => {
    it("Then it succeeds with a JSON-RPC result (enableJsonResponse)", async () => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: initializeBody(),
      });
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get("content-type") ?? "",
        /application\/json/,
        "initialize must come back as JSON, not an SSE stream",
      );
      const body = (await res.json()) as { jsonrpc: string; result?: unknown };
      assert.equal(body.jsonrpc, "2.0");
      assert.ok(body.result, "expected a JSON-RPC result");
    });
  });

  describe("When no auth token is configured (open mode)", () => {
    it("Then /mcp is reachable without any bearer header", async () => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: initializeBody(),
      });
      assert.equal(res.status, 200);
    });
  });
});

describe("Given the split between app.ts and the entrypoint", () => {
  describe("When app.ts is imported", () => {
    it("Then building the app opens no socket (createApp does not listen)", async () => {
      // A regression that put `app.listen()` into app.ts would surface as a live
      // server handle the moment the module is built. An express app is a request
      // handler (a function), not a listening server, until *something else*
      // (http.ts) calls listen.
      const getHandles = (process as unknown as {
        _getActiveHandles: () => unknown[];
      })._getActiveHandles.bind(process);
      const before = getHandles().length;
      const app = createApp(new MemoryStore());
      const after = getHandles().length;
      assert.equal(after, before, "createApp must not open a socket");
      assert.equal(typeof app, "function", "express app is a request handler");
    });
  });
});

describe("Given the app is built WITH a shared-secret bearer token", () => {
  const TOKEN = "s3cret-perimeter-token";
  let base: string;
  let stop: () => Promise<void>;

  before(async () => {
    ({ base, stop } = await boot(
      createApp(new MemoryStore(), { authToken: TOKEN }),
    ));
  });
  after(() => stop());

  describe("When POST /mcp arrives with no bearer header", () => {
    it("Then it is rejected 401 in a JSON-RPC envelope", async () => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: initializeBody(),
      });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = (await res.json()) as { jsonrpc: string; error?: { code: number } };
      assert.equal(body.jsonrpc, "2.0");
      assert.ok(body.error, "401 must carry a JSON-RPC error");
    });
  });

  describe("When POST /mcp arrives with the WRONG bearer", () => {
    it("Then it is rejected 401 in a JSON-RPC envelope", async () => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: "Bearer not-the-token" },
        body: initializeBody(),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { jsonrpc: string };
      assert.equal(body.jsonrpc, "2.0");
    });
  });

  describe("When POST /mcp arrives with the CORRECT bearer", () => {
    it("Then it passes the gate and initialize succeeds (200)", async () => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: initializeBody(),
      });
      assert.equal(res.status, 200);
    });
  });

  describe("When the 405 routes (GET/DELETE /mcp) are hit without auth", () => {
    it("Then the gate fires first: 401, not 405", async () => {
      for (const method of ["GET", "DELETE"]) {
        const res = await fetch(`${base}/mcp`, { method });
        assert.equal(res.status, 401, `${method} /mcp must be gated`);
      }
    });
  });

  describe("When /health is hit without auth", () => {
    it("Then it is never gated (200)", async () => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
    });
  });
});

describe("Given the request body cap is mounted after the gate", () => {
  const TOKEN = "s3cret-perimeter-token";
  let base: string;
  let stop: () => Promise<void>;

  before(async () => {
    ({ base, stop } = await boot(
      createApp(new MemoryStore(), { authToken: TOKEN }),
    ));
  });
  after(() => stop());

  describe("When an authenticated 300kb body is POSTed to /mcp", () => {
    it("Then it is 413 with JSON-RPC bytes, not finalhandler HTML", async () => {
      const huge = "x".repeat(300 * 1024);
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: huge } }),
      });
      assert.equal(res.status, 413);
      assert.match(
        res.headers.get("content-type") ?? "",
        /application\/json/,
        "413 must be JSON-RPC, not HTML from finalhandler",
      );
      const body = (await res.json()) as { jsonrpc: string; error?: unknown };
      assert.equal(body.jsonrpc, "2.0");
      assert.ok(body.error, "413 must carry a JSON-RPC error envelope");
    });
  });

  describe("When an authenticated body UNDER 256kb is POSTed to /mcp", () => {
    it("Then it passes the cap (not 413)", async () => {
      const pad = "y".repeat(100 * 1024); // ~100kb, comfortably under the cap
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: initializeBody({ _pad: pad }),
      });
      assert.notEqual(res.status, 413, "a sub-cap body must not be rejected as too large");
    });
  });
});
