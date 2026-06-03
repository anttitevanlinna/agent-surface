/**
 * Tool-layer tests: drive the real MCP server (createServer) through an
 * in-memory client/server transport pair. This exercises tool registration,
 * argument schemas, and the text responses agents actually see — without
 * spinning up HTTP.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryStore } from "../src/memoryStore.ts";
import { createServer } from "../src/server.ts";

// Keep logs out of test output.
process.env.LOG_LEVEL = "silent";

/** A connected client sharing one store with the server (mirrors HTTP setup). */
async function connect(store: MemoryStore) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(store);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Call a tool and return its first text block. */
async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: res.content[0].text, isError: res.isError ?? false };
}

/** Pull "sessionId: xxxx" / "councilId: xxxx" out of a response. */
function field(text: string, label: string): string {
  const m = text.match(new RegExp(`${label}:\\s*(\\S+)`));
  assert.ok(m, `expected "${label}" in:\n${text}`);
  return m![1];
}

/** Register a session and return its id. */
async function register(client: Client, name: string): Promise<string> {
  const res = await callText(client, "register_session", { name });
  return field(res.text, "sessionId");
}

test("tools/list exposes all seven tools", async () => {
  const client = await connect(new MemoryStore());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "create_council",
      "get_messages",
      "join_council",
      "list_councils",
      "list_participants",
      "register_session",
      "send_message",
    ],
  );
});

test("end-to-end council flow over MCP", async () => {
  const store = new MemoryStore();
  const chair = await connect(store);
  const expert = await connect(store); // separate client, shared store

  const chairSession = await register(chair, "Chair");
  const aliceSession = await register(expert, "Alice");

  const created = await callText(chair, "create_council", {
    topic: "Ship v2 today?",
    session: chairSession,
  });
  const councilId = field(created.text, "councilId");

  await callText(expert, "join_council", {
    councilId,
    session: aliceSession,
    role: "Security",
  });

  await callText(chair, "send_message", {
    councilId,
    session: chairSession,
    content: "Weigh in.",
  });
  await callText(expert, "send_message", {
    councilId,
    session: aliceSession,
    content: "Unpatched CVE — wait.",
    kind: "proposal",
  });

  const feed = await callText(expert, "get_messages", {
    councilId,
    session: aliceSession,
  });
  assert.match(feed.text, /Weigh in\./);
  assert.match(feed.text, /\[PROPOSAL\]/);
  assert.match(feed.text, /latest seq: 2/);
});

test("registering a session is a precondition for sending", async () => {
  const store = new MemoryStore();
  const chair = await connect(store);
  const chairSession = await register(chair, "Chair");
  const created = await callText(chair, "create_council", {
    topic: "x",
    session: chairSession,
  });
  const councilId = field(created.text, "councilId");

  // An unregistered session id can't send.
  const res = await callText(chair, "send_message", {
    councilId,
    session: "never-registered",
    content: "hi",
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /No session|not a member/);
});

test("a duplicate session name is rejected as a tool error", async () => {
  const client = await connect(new MemoryStore());
  await callText(client, "register_session", { name: "Coordinator" });
  const dup = await callText(client, "register_session", {
    name: "Coordinator",
  });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already registered/);
});

test("non-chair decision is rejected as a tool error", async () => {
  const store = new MemoryStore();
  const client = await connect(store);
  const chairSession = await register(client, "Chair");
  const aliceSession = await register(client, "Alice");
  const created = await callText(client, "create_council", {
    topic: "x",
    session: chairSession,
  });
  const councilId = field(created.text, "councilId");
  await callText(client, "join_council", {
    councilId,
    session: aliceSession,
  });

  const res = await callText(client, "send_message", {
    councilId,
    session: aliceSession,
    content: "We ship.",
    kind: "decision",
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /Only the chair/);
});

test("unknown council surfaces a clean tool error, not a crash", async () => {
  const client = await connect(new MemoryStore());
  const res = await callText(client, "list_participants", {
    councilId: "does-not-exist",
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /No council/);
});
