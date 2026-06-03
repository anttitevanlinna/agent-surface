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

/**
 * A named identity, registered once on the server and reused across councils.
 * Registration is a precondition: nothing else — creating a council, joining
 * one, sending or reading messages — works until you hold a `sessionId`.
 * Names are unique server-wide, so a session is a stable, human-readable handle.
 */
export interface Session {
  id: string;
  name: string;
  registeredAt: string; // ISO timestamp
}

export interface Council {
  id: string;
  topic: string;
  chairSessionId: string;
  createdAt: string; // ISO timestamp
}

/**
 * A session's membership in one council. The same session can hold several
 * memberships (one per council it has joined); each carries the role and the
 * chair flag for that council. `name` is denormalized from the session so
 * rendering a message never needs a second lookup.
 */
export interface Membership {
  councilId: string;
  sessionId: string;
  name: string;
  role: string;
  isChair: boolean;
  joinedAt: string; // ISO timestamp
}

export interface Message {
  id: string;
  councilId: string;
  seq: number; // monotonic per council; the cursor agents page on
  fromSessionId: string;
  fromName: string;
  /** null = broadcast to the whole council; otherwise a specific session id */
  toSessionId: string | null;
  kind: MessageKind;
  content: string;
  createdAt: string; // ISO timestamp
}

export interface RegisterSessionInput {
  name: string;
}

export interface CreateCouncilInput {
  topic: string;
  /** A registered session that becomes the chair. */
  sessionId: string;
  chairRole?: string;
}

export interface JoinCouncilInput {
  councilId: string;
  /** A registered session joining as a member. */
  sessionId: string;
  role?: string;
}

export interface SendMessageInput {
  councilId: string;
  fromSessionId: string;
  content: string;
  /** Specific recipient session id, or omitted/null for a broadcast. */
  toSessionId?: string | null;
  kind?: MessageKind;
}

export interface Store {
  /**
   * Register a named session. Names are unique server-wide; registering a name
   * that's already taken is rejected. Returns the session, whose `id` is the
   * capability token used on every later call.
   */
  registerSession(input: RegisterSessionInput): Promise<Session>;

  getSession(sessionId: string): Promise<Session | undefined>;

  createCouncil(
    input: CreateCouncilInput,
  ): Promise<{ council: Council; chair: Membership }>;

  getCouncil(councilId: string): Promise<Council | undefined>;

  listCouncils(): Promise<Council[]>;

  joinCouncil(input: JoinCouncilInput): Promise<Membership>;

  getMembership(
    councilId: string,
    sessionId: string,
  ): Promise<Membership | undefined>;

  listParticipants(councilId: string): Promise<Membership[]>;

  sendMessage(input: SendMessageInput): Promise<Message>;

  /**
   * Messages visible to `sessionId` in `councilId` with seq > `sinceSeq`,
   * in ascending seq order. Visible = broadcasts + messages addressed to the
   * session + messages the session itself sent.
   */
  getMessages(
    councilId: string,
    sessionId: string,
    sinceSeq?: number,
  ): Promise<Message[]>;
}

/** Thrown when an input refers to a session/council that doesn't exist, or a
 * caller tries something their role doesn't permit. The MCP layer turns these
 * into clean tool errors rather than stack traces. */
export class CoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationError";
  }
}
