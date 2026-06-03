import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memoryStore.ts";
import { CoordinationError } from "../src/store.ts";

async function council() {
  const store = new MemoryStore();
  const { council, chair } = await store.createCouncil({
    topic: "Ship or wait?",
    chairName: "Coordinator",
  });
  const alice = await store.joinCouncil({
    councilId: council.id,
    name: "Alice",
    role: "Security",
  });
  const bob = await store.joinCouncil({
    councilId: council.id,
    name: "Bob",
    role: "Perf",
  });
  return { store, councilId: council.id, chair, alice, bob };
}

test("broadcasts are visible to everyone", async () => {
  const { store, councilId, chair, alice, bob } = await council();
  await store.sendMessage({
    councilId,
    fromAgentId: chair.id,
    content: "Welcome all.",
  });
  for (const agent of [chair, alice, bob]) {
    const msgs = await store.getMessages(councilId, agent.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "Welcome all.");
    assert.equal(msgs[0].toAgentId, null);
  }
});

test("direct messages reach only sender and recipient", async () => {
  const { store, councilId, chair, alice, bob } = await council();
  await store.sendMessage({
    councilId,
    fromAgentId: alice.id,
    content: "Just for the chair.",
    toAgentId: chair.id,
  });
  assert.equal((await store.getMessages(councilId, chair.id)).length, 1);
  assert.equal((await store.getMessages(councilId, alice.id)).length, 1);
  assert.equal((await store.getMessages(councilId, bob.id)).length, 0);
});

test("sinceSeq pages only newer messages", async () => {
  const { store, councilId, chair, alice } = await council();
  await store.sendMessage({ councilId, fromAgentId: chair.id, content: "one" });
  const second = await store.sendMessage({
    councilId,
    fromAgentId: chair.id,
    content: "two",
  });
  const fresh = await store.getMessages(councilId, alice.id, 1);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].content, "two");
  assert.equal(fresh[0].seq, second.seq);
});

test("seq is monotonic per council", async () => {
  const { store, councilId, chair } = await council();
  const a = await store.sendMessage({ councilId, fromAgentId: chair.id, content: "a" });
  const b = await store.sendMessage({ councilId, fromAgentId: chair.id, content: "b" });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
});

test("only the chair can post a decision", async () => {
  const { store, councilId, chair, alice } = await council();
  await assert.rejects(
    store.sendMessage({
      councilId,
      fromAgentId: alice.id,
      content: "We ship.",
      kind: "decision",
    }),
    CoordinationError,
  );
  const decision = await store.sendMessage({
    councilId,
    fromAgentId: chair.id,
    content: "We ship.",
    kind: "decision",
  });
  assert.equal(decision.kind, "decision");
});

test("non-decision kinds are open to all members", async () => {
  const { store, councilId, alice } = await council();
  const proposal = await store.sendMessage({
    councilId,
    fromAgentId: alice.id,
    content: "Propose we wait a week.",
    kind: "proposal",
  });
  assert.equal(proposal.kind, "proposal");
});

test("sending into an unknown council fails", async () => {
  const { store, chair } = await council();
  await assert.rejects(
    store.sendMessage({ councilId: "nope", fromAgentId: chair.id, content: "x" }),
    CoordinationError,
  );
});

test("a stranger cannot send to a council", async () => {
  const { store, councilId } = await council();
  await assert.rejects(
    store.sendMessage({ councilId, fromAgentId: "stranger", content: "x" }),
    CoordinationError,
  );
});

test("directing a message to a non-member fails", async () => {
  const { store, councilId, chair } = await council();
  await assert.rejects(
    store.sendMessage({
      councilId,
      fromAgentId: chair.id,
      content: "x",
      toAgentId: "ghost",
    }),
    CoordinationError,
  );
});

test("listParticipants returns members in join order with chair flagged", async () => {
  const { store, councilId } = await council();
  const members = await store.listParticipants(councilId);
  assert.deepEqual(
    members.map((m) => m.name),
    ["Coordinator", "Alice", "Bob"],
  );
  assert.equal(members[0].isChair, true);
  assert.equal(members[1].isChair, false);
});
