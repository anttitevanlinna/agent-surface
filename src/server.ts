/**
 * The MCP server: maps coordination tools onto a Store.
 *
 * `createServer(store)` builds a fresh McpServer wired to a *shared* store. In
 * stateless HTTP mode we build one of these per request, but they all point at
 * the same store — which is exactly how independent agents end up in the same
 * council.
 *
 * Identity is a *session*: register a name once, get a sessionId, and act as
 * that session everywhere. Registration is a precondition — create_council,
 * join_council, send_message and get_messages all reject an unknown session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log } from "./logger.js";
import { CoordinationError, type Message, type Store } from "./store.js";

const messageKind = z.enum(["message", "proposal", "vote", "decision"]);

/** Render a message for an agent's eyes — compact, scannable. */
function renderMessage(m: Message): string {
  const to = m.toSessionId ? `→ ${m.toSessionId}` : "→ all";
  const tag = m.kind === "message" ? "" : ` [${m.kind.toUpperCase()}]`;
  return `#${m.seq} ${m.fromName} (${m.fromSessionId}) ${to}${tag}: ${m.content}`;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Run a tool body with logging: log the call, time it, and turn
 * CoordinationErrors into clean tool errors (logged at warn, not as crashes).
 * Unexpected errors are logged at error and re-thrown.
 */
async function guard(
  toolName: string,
  fn: () => Promise<ReturnType<typeof ok>>,
) {
  const start = Date.now();
  log.info("tool call", { tool: toolName });
  try {
    const result = await fn();
    log.debug("tool ok", { tool: toolName, ms: Date.now() - start });
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof CoordinationError) {
      log.warn("tool rejected", { tool: toolName, ms, reason: err.message });
      return fail(`Error: ${err.message}`);
    }
    log.error("tool failed", {
      tool: toolName,
      ms,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function createServer(store: Store): McpServer {
  const server = new McpServer({
    name: "agent-surface",
    version: "0.1.0",
  });

  server.registerTool(
    "register_session",
    {
      title: "Register a session",
      description:
        "Register a named session — your identity on this server. Returns a sessionId you must hold and pass on every later call. You must register before you can create or join a council, or send or read messages. Names are unique server-wide.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "A unique display name for this session (e.g. 'Coordinator').",
          ),
      },
    },
    async ({ name }) =>
      guard("register_session", async () => {
        const session = await store.registerSession({ name });
        return ok(
          [
            `Session registered.`,
            `sessionId: ${session.id}  (hold this — pass it on every call)`,
            `name: ${session.name}`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "create_council",
    {
      title: "Create a council",
      description:
        "Open a new coordination space (a 'council') on a topic and register your session as the chair. Returns the councilId to share with other agents. Pass your sessionId (from register_session).",
      inputSchema: {
        topic: z.string().describe("What this council is convened to decide."),
        session: z
          .string()
          .describe(
            "Your sessionId (from register_session). You become the chair.",
          ),
        chairRole: z
          .string()
          .optional()
          .describe("Optional role label for the chair. Defaults to 'Chair'."),
      },
    },
    async ({ topic, session, chairRole }) =>
      guard("create_council", async () => {
        const { council, chair } = await store.createCouncil({
          topic,
          sessionId: session,
          chairRole,
        });
        return ok(
          [
            `Council created.`,
            `councilId: ${council.id}  (share this with other agents)`,
            `chair: ${chair.name} (${chair.sessionId}) — you chair this council`,
            `topic: ${council.topic}`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "join_council",
    {
      title: "Join a council",
      description:
        "Join an existing council by id, registering your session as a participant. Pass your sessionId (from register_session).",
      inputSchema: {
        councilId: z.string().describe("The council id to join."),
        session: z.string().describe("Your sessionId (from register_session)."),
        role: z
          .string()
          .optional()
          .describe(
            "Optional role label (e.g. 'Security expert'). Defaults to 'Member'.",
          ),
      },
    },
    async ({ councilId, session, role }) =>
      guard("join_council", async () => {
        const membership = await store.joinCouncil({
          councilId,
          sessionId: session,
          role,
        });
        const council = await store.getCouncil(councilId);
        const participants = await store.listParticipants(councilId);
        return ok(
          [
            `Joined council ${councilId} as ${membership.name}.`,
            `topic: ${council?.topic ?? "(unknown)"}`,
            `participants (${participants.length}):`,
            ...participants.map(
              (p) =>
                `  - ${p.name} (${p.sessionId}) — ${p.role}${p.isChair ? " [chair]" : ""}`,
            ),
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_councils",
    {
      title: "List councils",
      description:
        "List all councils currently open on this server, newest first. Use to discover a council to join.",
      inputSchema: {},
    },
    async () =>
      guard("list_councils", async () => {
        const councils = await store.listCouncils();
        if (councils.length === 0) return ok("No councils open yet.");
        return ok(
          councils
            .map((c) => `- ${c.id}: ${c.topic}  (created ${c.createdAt})`)
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_participants",
    {
      title: "List participants",
      description: "List the members of a council and their roles.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
      },
    },
    async ({ councilId }) =>
      guard("list_participants", async () => {
        const council = await store.getCouncil(councilId);
        if (!council) {
          throw new CoordinationError(`No council with id "${councilId}".`);
        }
        const participants = await store.listParticipants(councilId);
        return ok(
          [
            `Council ${councilId} — ${council.topic}`,
            `participants (${participants.length}):`,
            ...participants.map(
              (p) =>
                `  - ${p.name} (${p.sessionId}) — ${p.role}${p.isChair ? " [chair]" : ""}`,
            ),
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message",
      description:
        "Post a message to the council as your session. Omit `to` to broadcast to everyone, or set it to a participant's sessionId for a direct message. Use `kind` to mark proposals, votes, or — chair only — a binding decision.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        session: z.string().describe("Your sessionId (from register_session)."),
        content: z.string().describe("The message body."),
        to: z
          .string()
          .optional()
          .describe(
            "Recipient sessionId for a direct message. Omit to broadcast to the whole council.",
          ),
        kind: messageKind
          .optional()
          .describe(
            "message (default), proposal, vote, or decision. Only the chair may post a 'decision'.",
          ),
      },
    },
    async ({ councilId, session, content, to, kind }) =>
      guard("send_message", async () => {
        const message = await store.sendMessage({
          councilId,
          fromSessionId: session,
          content,
          toSessionId: to ?? null,
          kind,
        });
        return ok(
          `Sent #${message.seq} (id ${message.id}, kind ${message.kind}, ${
            message.toSessionId ? `to ${message.toSessionId}` : "broadcast"
          }).`,
        );
      }),
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get messages",
      description:
        "Read messages addressed to your session (broadcasts + direct messages to you + your own), in order. Pass `sinceSeq` with the last seq you've seen to poll for only new messages. Returns the latest seq so you can poll again.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        session: z.string().describe("Your sessionId (from register_session)."),
        sinceSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Only return messages newer than this seq. Defaults to 0 (everything visible to you).",
          ),
      },
    },
    async ({ councilId, session, sinceSeq }) =>
      guard("get_messages", async () => {
        const messages = await store.getMessages(councilId, session, sinceSeq);
        if (messages.length === 0) {
          return ok(`No new messages (sinceSeq ${sinceSeq ?? 0}).`);
        }
        const latest = messages[messages.length - 1].seq;
        return ok(
          [
            ...messages.map(renderMessage),
            ``,
            `(latest seq: ${latest} — pass sinceSeq=${latest} next time)`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "create_proposal",
    {
      title: "Create a proposal",
      description:
        "Open a proposal for the council to vote on. Returns a proposalId and broadcasts the proposal to the feed so members can vote on it with cast_vote. Members vote among the options you declare (plus 'abstain', always available).",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        session: z.string().describe("Your sessionId (from register_session)."),
        text: z.string().describe("What the council is voting on."),
        options: z
          .array(z.string())
          .optional()
          .describe(
            "The choices voters may pick. Defaults to ['yes', 'no']. Must be at least two distinct values; 'abstain' is reserved.",
          ),
      },
    },
    async ({ councilId, session, text, options }) =>
      guard("create_proposal", async () => {
        const proposal = await store.createProposal({
          councilId,
          sessionId: session,
          text,
          options,
        });
        return ok(
          [
            `Proposal opened.`,
            `proposalId: ${proposal.id}  (vote on it with cast_vote)`,
            `text: ${proposal.text}`,
            `options: ${proposal.options.join(" / ")} / abstain`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "cast_vote",
    {
      title: "Cast a vote",
      description:
        "Vote on a proposal as your session. Your choice must be one of the proposal's options, or 'abstain'. Voting again replaces your previous vote.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        session: z.string().describe("Your sessionId (from register_session)."),
        proposalId: z.string().describe("The proposalId (from create_proposal)."),
        choice: z
          .string()
          .describe("One of the proposal's options, or 'abstain'."),
      },
    },
    async ({ councilId, session, proposalId, choice }) =>
      guard("cast_vote", async () => {
        const vote = await store.castVote({
          councilId,
          sessionId: session,
          proposalId,
          choice,
        });
        return ok(`Vote recorded: "${vote.choice}" on proposal ${vote.proposalId}.`);
      }),
  );

  server.registerTool(
    "tally",
    {
      title: "Tally a proposal",
      description:
        "Count the votes on a proposal: each option with its count, abstentions, and turnout against the council size.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        proposalId: z.string().describe("The proposalId to count."),
      },
    },
    async ({ councilId, proposalId }) =>
      guard("tally", async () => {
        const result = await store.tally(councilId, proposalId);
        const lines = Object.entries(result.counts).map(
          ([option, count]) => `  ${option}: ${count}`,
        );
        return ok(
          [
            `Tally — proposal ${result.proposalId}: "${result.text}"`,
            ...lines,
            `  abstain: ${result.abstain}`,
            `turnout: ${result.voted} of ${result.members} members voted`,
          ].join("\n"),
        );
      }),
  );

  return server;
}
