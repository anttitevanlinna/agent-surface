/**
 * In-memory implementation of the Store contract.
 *
 * Good enough for a single running server instance and a local council. State
 * lives only as long as the process. When we deploy with a free database, write
 * a sibling that talks to it and satisfies the same interface — nothing else
 * changes.
 */

import { randomUUID } from "node:crypto";
import {
  type Council,
  CoordinationError,
  type CreateCouncilInput,
  type JoinCouncilInput,
  type Membership,
  type Message,
  type RegisterSessionInput,
  type SendMessageInput,
  type Session,
  type Store,
} from "./store.js";

/** Short, human-glanceable id — enough entropy for a council, easier to paste. */
function shortId(): string {
  return randomUUID().slice(0, 8);
}

function now(): string {
  return new Date().toISOString();
}

/** Composite key for a session's membership in a council. */
function memberKey(councilId: string, sessionId: string): string {
  return `${councilId}:${sessionId}`;
}

export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private sessionIdByName = new Map<string, string>(); // name -> sessionId (uniqueness)
  private councils = new Map<string, Council>();
  private memberships = new Map<string, Membership>(); // `${councilId}:${sessionId}`
  private messages = new Map<string, Message[]>(); // councilId -> ordered messages
  private seqByCouncil = new Map<string, number>(); // councilId -> last seq used

  async registerSession(input: RegisterSessionInput): Promise<Session> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new CoordinationError("A session name must not be empty.");
    }
    if (this.sessionIdByName.has(name)) {
      throw new CoordinationError(
        `The session name "${name}" is already registered.`,
      );
    }
    const session: Session = {
      id: shortId(),
      name,
      registeredAt: now(),
    };
    this.sessions.set(session.id, session);
    this.sessionIdByName.set(name, session.id);
    return session;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async createCouncil(
    input: CreateCouncilInput,
  ): Promise<{ council: Council; chair: Membership }> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new CoordinationError(
        `No session with id "${input.sessionId}". Register a session first.`,
      );
    }
    const councilId = shortId();
    const timestamp = now();

    const council: Council = {
      id: councilId,
      topic: input.topic,
      chairSessionId: session.id,
      createdAt: timestamp,
    };
    const chair: Membership = {
      councilId,
      sessionId: session.id,
      name: session.name,
      role: input.chairRole ?? "Chair",
      isChair: true,
      joinedAt: timestamp,
    };

    this.councils.set(councilId, council);
    this.memberships.set(memberKey(councilId, session.id), chair);
    this.messages.set(councilId, []);
    this.seqByCouncil.set(councilId, 0);

    return { council, chair };
  }

  async getCouncil(councilId: string): Promise<Council | undefined> {
    return this.councils.get(councilId);
  }

  async listCouncils(): Promise<Council[]> {
    return [...this.councils.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  async joinCouncil(input: JoinCouncilInput): Promise<Membership> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new CoordinationError(
        `No session with id "${input.sessionId}". Register a session first.`,
      );
    }
    const key = memberKey(input.councilId, session.id);
    if (this.memberships.has(key)) {
      throw new CoordinationError(
        `Session "${session.name}" is already a member of council "${input.councilId}".`,
      );
    }
    const membership: Membership = {
      councilId: input.councilId,
      sessionId: session.id,
      name: session.name,
      role: input.role ?? "Member",
      isChair: false,
      joinedAt: now(),
    };
    this.memberships.set(key, membership);
    return membership;
  }

  async getMembership(
    councilId: string,
    sessionId: string,
  ): Promise<Membership | undefined> {
    return this.memberships.get(memberKey(councilId, sessionId));
  }

  async listParticipants(councilId: string): Promise<Membership[]> {
    return [...this.memberships.values()]
      .filter((m) => m.councilId === councilId)
      .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const sender = this.memberships.get(
      memberKey(input.councilId, input.fromSessionId),
    );
    if (!sender) {
      throw new CoordinationError(
        `Session "${input.fromSessionId}" is not a member of council "${input.councilId}".`,
      );
    }

    const toSessionId = input.toSessionId ?? null;
    if (toSessionId !== null) {
      const recipient = this.memberships.get(
        memberKey(input.councilId, toSessionId),
      );
      if (!recipient) {
        throw new CoordinationError(
          `Recipient "${toSessionId}" is not a member of council "${input.councilId}".`,
        );
      }
    }

    const kind = input.kind ?? "message";
    // A chair's gavel: only the chair may record a binding decision.
    if (kind === "decision" && !sender.isChair) {
      throw new CoordinationError(
        "Only the chair can post a message of kind 'decision'.",
      );
    }

    const seq = (this.seqByCouncil.get(input.councilId) ?? 0) + 1;
    this.seqByCouncil.set(input.councilId, seq);

    const message: Message = {
      id: shortId(),
      councilId: input.councilId,
      seq,
      fromSessionId: sender.sessionId,
      fromName: sender.name,
      toSessionId,
      kind,
      content: input.content,
      createdAt: now(),
    };
    this.messages.get(input.councilId)!.push(message);
    return message;
  }

  async getMessages(
    councilId: string,
    sessionId: string,
    sinceSeq = 0,
  ): Promise<Message[]> {
    const council = this.councils.get(councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${councilId}".`);
    }
    const member = this.memberships.get(memberKey(councilId, sessionId));
    if (!member) {
      throw new CoordinationError(
        `Session "${sessionId}" is not a member of council "${councilId}".`,
      );
    }

    const all = this.messages.get(councilId) ?? [];
    return all.filter(
      (m) =>
        m.seq > sinceSeq &&
        (m.toSessionId === null ||
          m.toSessionId === sessionId ||
          m.fromSessionId === sessionId),
    );
  }
}
