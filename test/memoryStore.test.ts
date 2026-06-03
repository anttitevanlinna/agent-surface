import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memoryStore.ts";
import { CoordinationError } from "../src/store.ts";

/** A council with a chair (Coordinator) and two members (Alice, Bob), each a
 * registered session. Returns the store plus everyone's sessionId. */
async function council() {
  const store = new MemoryStore();
  const coordinator = await store.registerSession({ name: "Coordinator" });
  const aliceSession = await store.registerSession({ name: "Alice" });
  const bobSession = await store.registerSession({ name: "Bob" });

  const { council } = await store.createCouncil({
    topic: "Ship or wait?",
    sessionId: coordinator.id,
  });
  await store.joinCouncil({
    councilId: council.id,
    sessionId: aliceSession.id,
    role: "Security",
  });
  await store.joinCouncil({
    councilId: council.id,
    sessionId: bobSession.id,
    role: "Perf",
  });
  return {
    store,
    councilId: council.id,
    chair: coordinator,
    alice: aliceSession,
    bob: bobSession,
  };
}

test("a session must be registered before it can chair a council", async () => {
  const store = new MemoryStore();
  await assert.rejects(
    store.createCouncil({ topic: "x", sessionId: "never-registered" }),
    CoordinationError,
  );
});

test("a session must be registered before it can send messages", async () => {
  const store = new MemoryStore();
  const chair = await store.registerSession({ name: "Chair" });
  const { council } = await store.createCouncil({
    topic: "x",
    sessionId: chair.id,
  });
  await assert.rejects(
    store.sendMessage({
      councilId: council.id,
      fromSessionId: "never-registered",
      content: "x",
    }),
    CoordinationError,
  );
});

test("session names are unique server-wide", async () => {
  const store = new MemoryStore();
  await store.registerSession({ name: "Coordinator" });
  await assert.rejects(
    store.registerSession({ name: "Coordinator" }),
    CoordinationError,
  );
});

test("one session can join and message across several councils", async () => {
  const store = new MemoryStore();
  const chair = await store.registerSession({ name: "Chair" });
  const roamer = await store.registerSession({ name: "Roamer" });

  const a = await store.createCouncil({ topic: "A", sessionId: chair.id });
  const b = await store.createCouncil({ topic: "B", sessionId: chair.id });
  await store.joinCouncil({ councilId: a.council.id, sessionId: roamer.id });
  await store.joinCouncil({ councilId: b.council.id, sessionId: roamer.id });

  const inA = await store.sendMessage({
    councilId: a.council.id,
    fromSessionId: roamer.id,
    content: "hello A",
  });
  const inB = await store.sendMessage({
    councilId: b.council.id,
    fromSessionId: roamer.id,
    content: "hello B",
  });
  // Same session, but seq is per-council — both start at 1.
  assert.equal(inA.seq, 1);
  assert.equal(inB.seq, 1);
  assert.equal((await store.getMessages(a.council.id, roamer.id)).length, 1);
  assert.equal((await store.getMessages(b.council.id, roamer.id)).length, 1);
});

test("joining the same council twice with one session fails", async () => {
  const { store, councilId, alice } = await council();
  await assert.rejects(
    store.joinCouncil({ councilId, sessionId: alice.id }),
    CoordinationError,
  );
});

test("broadcasts are visible to everyone", async () => {
  const { store, councilId, chair, alice, bob } = await council();
  await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "Welcome all.",
  });
  for (const session of [chair, alice, bob]) {
    const msgs = await store.getMessages(councilId, session.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "Welcome all.");
    assert.equal(msgs[0].toSessionId, null);
  }
});

test("direct messages reach only sender and recipient", async () => {
  const { store, councilId, chair, alice, bob } = await council();
  await store.sendMessage({
    councilId,
    fromSessionId: alice.id,
    content: "Just for the chair.",
    toSessionId: chair.id,
  });
  assert.equal((await store.getMessages(councilId, chair.id)).length, 1);
  assert.equal((await store.getMessages(councilId, alice.id)).length, 1);
  assert.equal((await store.getMessages(councilId, bob.id)).length, 0);
});

test("sinceSeq pages only newer messages", async () => {
  const { store, councilId, chair, alice } = await council();
  await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "one",
  });
  const second = await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "two",
  });
  const fresh = await store.getMessages(councilId, alice.id, 1);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].content, "two");
  assert.equal(fresh[0].seq, second.seq);
});

test("seq is monotonic per council", async () => {
  const { store, councilId, chair } = await council();
  const a = await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "a",
  });
  const b = await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "b",
  });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
});

test("only the chair can post a decision", async () => {
  const { store, councilId, chair, alice } = await council();
  await assert.rejects(
    store.sendMessage({
      councilId,
      fromSessionId: alice.id,
      content: "We ship.",
      kind: "decision",
    }),
    CoordinationError,
  );
  const decision = await store.sendMessage({
    councilId,
    fromSessionId: chair.id,
    content: "We ship.",
    kind: "decision",
  });
  assert.equal(decision.kind, "decision");
});

test("non-decision kinds are open to all members", async () => {
  const { store, councilId, alice } = await council();
  const proposal = await store.sendMessage({
    councilId,
    fromSessionId: alice.id,
    content: "Propose we wait a week.",
    kind: "proposal",
  });
  assert.equal(proposal.kind, "proposal");
});

test("sending into an unknown council fails", async () => {
  const { store, chair } = await council();
  await assert.rejects(
    store.sendMessage({
      councilId: "nope",
      fromSessionId: chair.id,
      content: "x",
    }),
    CoordinationError,
  );
});

test("a non-member session cannot send to a council", async () => {
  const { store, councilId } = await council();
  const stranger = await store.registerSession({ name: "Stranger" });
  await assert.rejects(
    store.sendMessage({
      councilId,
      fromSessionId: stranger.id,
      content: "x",
    }),
    CoordinationError,
  );
});

test("directing a message to a non-member fails", async () => {
  const { store, councilId, chair } = await council();
  await assert.rejects(
    store.sendMessage({
      councilId,
      fromSessionId: chair.id,
      content: "x",
      toSessionId: "ghost",
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

test("voting an option is case-insensitive and counts under the declared option", async () => {
  const { store, councilId, chair, alice } = await council();
  const proposal = await store.createProposal({
    councilId,
    sessionId: chair.id,
    text: "Ship v2 today?",
    options: ["Ship", "Wait"],
  });
  // Member votes with different casing than declared.
  const vote = await store.castVote({
    councilId,
    sessionId: alice.id,
    proposalId: proposal.id,
    choice: "ship",
  });
  // The vote is canonicalized to the declared option's casing...
  assert.equal(vote.choice, "Ship");
  // ...so the tally counts it under "Ship", not loses it.
  const result = await store.tally(councilId, proposal.id);
  assert.equal(result.counts["Ship"], 1);
  assert.equal(result.voted, 1);
});

test("declaring two options that differ only by case is refused as a collision", async () => {
  // The root issue: option identity must be defined once. If a vote for "ship"
  // matches a declared "Ship", then "Ship" and "ship" are the SAME option — so
  // declaring both is a collision and must be refused, not silently kept.
  const { store, councilId, chair } = await council();
  await assert.rejects(
    store.createProposal({
      councilId,
      sessionId: chair.id,
      text: "Ship v2?",
      options: ["Ship", "ship"],
    }),
    CoordinationError,
  );
});

test("an option that doesn't match any declared option is still rejected", async () => {
  const { store, councilId, chair, alice } = await council();
  const proposal = await store.createProposal({
    councilId,
    sessionId: chair.id,
    text: "Ship v2 today?",
    options: ["Ship", "Wait"],
  });
  await assert.rejects(
    store.castVote({
      councilId,
      sessionId: alice.id,
      proposalId: proposal.id,
      choice: "maybe",
    }),
    CoordinationError,
  );
});

test("votes are counted, including zeros and abstentions, with turnout", async () => {
  const { store, councilId, chair, alice, bob } = await council();
  const proposal = await store.createProposal({
    councilId,
    sessionId: chair.id,
    text: "Ship v2 today?",
    options: ["ship", "wait"],
  });
  await store.castVote({
    councilId,
    sessionId: alice.id,
    proposalId: proposal.id,
    choice: "wait",
  });
  await store.castVote({
    councilId,
    sessionId: bob.id,
    proposalId: proposal.id,
    choice: "wait",
  });
  await store.castVote({
    councilId,
    sessionId: chair.id,
    proposalId: proposal.id,
    choice: "abstain",
  });

  const result = await store.tally(councilId, proposal.id);
  assert.deepEqual(result.counts, { ship: 0, wait: 2 });
  assert.equal(result.abstain, 1);
  assert.equal(result.voted, 3);
});
