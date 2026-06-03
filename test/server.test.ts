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

/** Pull "councilId: xxxx" / "your agentId: xxxx" out of a response. */
function field(text: string, label: string): string {
  const m = text.match(new RegExp(`${label}:\\s*(\\S+)`));
  assert.ok(m, `expected "${label}" in:\n${text}`);
  return m![1];
}

test("tools/list exposes all six tools", async () => {
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
      "send_message",
    ],
  );
});

test("end-to-end council flow over MCP", async () => {
  const store = new MemoryStore();
  const chair = await connect(store);
  const expert = await connect(store); // separate client, shared store

  const created = await callText(chair, "create_council", {
    topic: "Ship v2 today?",
    chairName: "Chair",
  });
  const councilId = field(created.text, "councilId");
  const chairId = field(created.text, "your agentId");

  const joined = await callText(expert, "join_council", {
    councilId,
    name: "Alice",
    role: "Security",
  });
  const aliceId = field(joined.text, "your agentId");

  await callText(chair, "send_message", {
    councilId,
    fromAgentId: chairId,
    content: "Weigh in.",
  });
  await callText(expert, "send_message", {
    councilId,
    fromAgentId: aliceId,
    content: "Unpatched CVE — wait.",
    kind: "proposal",
  });

  const feed = await callText(expert, "get_messages", {
    councilId,
    agentId: aliceId,
  });
  assert.match(feed.text, /Weigh in\./);
  assert.match(feed.text, /\[PROPOSAL\]/);
  assert.match(feed.text, /latest seq: 2/);
});

test("non-chair decision is rejected as a tool error", async () => {
  const store = new MemoryStore();
  const client = await connect(store);
  const created = await callText(client, "create_council", {
    topic: "x",
    chairName: "Chair",
  });
  const councilId = field(created.text, "councilId");
  const joined = await callText(client, "join_council", {
    councilId,
    name: "Alice",
  });
  const aliceId = field(joined.text, "your agentId");

  const res = await callText(client, "send_message", {
    councilId,
    fromAgentId: aliceId,
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
