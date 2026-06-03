/**
 * The MCP server: maps coordination tools onto a Store.
 *
 * `createServer(store)` builds a fresh McpServer wired to a *shared* store. In
 * stateless HTTP mode we build one of these per request, but they all point at
 * the same store — which is exactly how independent agents end up in the same
 * council.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log } from "./logger.js";
import { CoordinationError, type Message, type Store } from "./store.js";

const messageKind = z.enum(["message", "proposal", "vote", "decision"]);

/** Render a message for an agent's eyes — compact, scannable. */
function renderMessage(m: Message): string {
  const to = m.toAgentId ? `→ ${m.toAgentId}` : "→ all";
  const tag = m.kind === "message" ? "" : ` [${m.kind.toUpperCase()}]`;
  return `#${m.seq} ${m.fromName} (${m.fromAgentId}) ${to}${tag}: ${m.content}`;
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
    "create_council",
    {
      title: "Create a council",
      description:
        "Open a new coordination space (a 'council') on a topic and register yourself as the chair. Returns the councilId to share with other agents, plus your own agentId. Use the agentId on every later call.",
      inputSchema: {
        topic: z.string().describe("What this council is convened to decide."),
        chairName: z
          .string()
          .describe("Display name for you, the chair (e.g. 'Coordinator')."),
        chairRole: z
          .string()
          .optional()
          .describe("Optional role label for the chair. Defaults to 'Chair'."),
      },
    },
    async ({ topic, chairName, chairRole }) =>
      guard("create_council", async () => {
        const { council, chair } = await store.createCouncil({
          topic,
          chairName,
          chairRole,
        });
        return ok(
          [
            `Council created.`,
            `councilId: ${council.id}  (share this with other agents)`,
            `your agentId: ${chair.id}  (you are the chair — use this id on every call)`,
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
        "Join an existing council by id, registering yourself as a participant. Returns your agentId, which you must pass on every later call.",
      inputSchema: {
        councilId: z.string().describe("The council id to join."),
        name: z.string().describe("Your display name in this council."),
        role: z
          .string()
          .optional()
          .describe(
            "Optional role label (e.g. 'Security expert'). Defaults to 'Member'.",
          ),
      },
    },
    async ({ councilId, name, role }) =>
      guard("join_council", async () => {
        const agent = await store.joinCouncil({ councilId, name, role });
        const council = await store.getCouncil(councilId);
        const participants = await store.listParticipants(councilId);
        return ok(
          [
            `Joined council ${councilId}.`,
            `your agentId: ${agent.id}  (use this id on every call)`,
            `topic: ${council?.topic ?? "(unknown)"}`,
            `participants (${participants.length}):`,
            ...participants.map(
              (p) =>
                `  - ${p.name} (${p.id}) — ${p.role}${p.isChair ? " [chair]" : ""}`,
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
                `  - ${p.name} (${p.id}) — ${p.role}${p.isChair ? " [chair]" : ""}`,
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
        "Post a message to the council. Omit `to` to broadcast to everyone, or set it to a participant's agentId for a direct message. Use `kind` to mark proposals, votes, or — chair only — a binding decision.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        fromAgentId: z
          .string()
          .describe("Your agentId (from create_council or join_council)."),
        content: z.string().describe("The message body."),
        to: z
          .string()
          .optional()
          .describe(
            "Recipient agentId for a direct message. Omit to broadcast to the whole council.",
          ),
        kind: messageKind
          .optional()
          .describe(
            "message (default), proposal, vote, or decision. Only the chair may post a 'decision'.",
          ),
      },
    },
    async ({ councilId, fromAgentId, content, to, kind }) =>
      guard("send_message", async () => {
        const message = await store.sendMessage({
          councilId,
          fromAgentId,
          content,
          toAgentId: to ?? null,
          kind,
        });
        return ok(
          `Sent #${message.seq} (id ${message.id}, kind ${message.kind}, ${
            message.toAgentId ? `to ${message.toAgentId}` : "broadcast"
          }).`,
        );
      }),
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get messages",
      description:
        "Read messages addressed to you (broadcasts + direct messages to you + your own), in order. Pass `sinceSeq` with the last seq you've seen to poll for only new messages. Returns the latest seq so you can poll again.",
      inputSchema: {
        councilId: z.string().describe("The council id."),
        agentId: z.string().describe("Your agentId."),
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
    async ({ councilId, agentId, sinceSeq }) =>
      guard("get_messages", async () => {
        const messages = await store.getMessages(councilId, agentId, sinceSeq);
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

  return server;
}
