/**
 * Domain types and the storage contract.
 *
 * Everything the coordination tools need is expressed through the `Store`
 * interface. The in-memory implementation (memoryStore.ts) is what we run this
 * session; a Postgres-backed implementation can satisfy the same contract later
 * without touching the MCP layer.
 *
 * All methods are async on purpose — an in-memory map doesn't need it, but a
 * network database does, and we don't want the call sites to change when we
 * swap the backend.
 */

export type MessageKind = "message" | "proposal" | "vote" | "decision";

export interface Council {
  id: string;
  topic: string;
  chairAgentId: string;
  createdAt: string; // ISO timestamp
}

export interface Agent {
  id: string;
  councilId: string;
  name: string;
  role: string;
  isChair: boolean;
  joinedAt: string; // ISO timestamp
}

export interface Message {
  id: string;
  councilId: string;
  seq: number; // monotonic per council; the cursor agents page on
  fromAgentId: string;
  fromName: string;
  /** null = broadcast to the whole council; otherwise a specific agent id */
  toAgentId: string | null;
  kind: MessageKind;
  content: string;
  createdAt: string; // ISO timestamp
}

export interface CreateCouncilInput {
  topic: string;
  chairName: string;
  chairRole?: string;
}

export interface JoinCouncilInput {
  councilId: string;
  name: string;
  role?: string;
}

export interface SendMessageInput {
  councilId: string;
  fromAgentId: string;
  content: string;
  /** Specific recipient agent id, or omitted/null for a broadcast. */
  toAgentId?: string | null;
  kind?: MessageKind;
}

export interface Store {
  createCouncil(
    input: CreateCouncilInput,
  ): Promise<{ council: Council; chair: Agent }>;

  getCouncil(councilId: string): Promise<Council | undefined>;

  listCouncils(): Promise<Council[]>;

  joinCouncil(input: JoinCouncilInput): Promise<Agent>;

  getAgent(agentId: string): Promise<Agent | undefined>;

  listParticipants(councilId: string): Promise<Agent[]>;

  sendMessage(input: SendMessageInput): Promise<Message>;

  /**
   * Messages visible to `agentId` in `councilId` with seq > `sinceSeq`,
   * in ascending seq order. Visible = broadcasts + messages addressed to the
   * agent + messages the agent itself sent.
   */
  getMessages(
    councilId: string,
    agentId: string,
    sinceSeq?: number,
  ): Promise<Message[]>;
}

/** Thrown when an input refers to a council/agent that doesn't exist, or a
 * caller tries something their role doesn't permit. The MCP layer turns these
 * into clean tool errors rather than stack traces. */
export class CoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationError";
  }
}
