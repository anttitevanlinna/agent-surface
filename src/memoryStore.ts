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
  type Agent,
  type Council,
  CoordinationError,
  type CreateCouncilInput,
  type JoinCouncilInput,
  type Message,
  type SendMessageInput,
  type Store,
} from "./store.js";

/** Short, human-glanceable id — enough entropy for a council, easier to paste. */
function shortId(): string {
  return randomUUID().slice(0, 8);
}

function now(): string {
  return new Date().toISOString();
}

export class MemoryStore implements Store {
  private councils = new Map<string, Council>();
  private agents = new Map<string, Agent>();
  private messages = new Map<string, Message[]>(); // councilId -> ordered messages
  private seqByCouncil = new Map<string, number>(); // councilId -> last seq used

  async createCouncil(
    input: CreateCouncilInput,
  ): Promise<{ council: Council; chair: Agent }> {
    const councilId = shortId();
    const chairId = shortId();
    const timestamp = now();

    const chair: Agent = {
      id: chairId,
      councilId,
      name: input.chairName,
      role: input.chairRole ?? "Chair",
      isChair: true,
      joinedAt: timestamp,
    };
    const council: Council = {
      id: councilId,
      topic: input.topic,
      chairAgentId: chairId,
      createdAt: timestamp,
    };

    this.councils.set(councilId, council);
    this.agents.set(chairId, chair);
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

  async joinCouncil(input: JoinCouncilInput): Promise<Agent> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const agent: Agent = {
      id: shortId(),
      councilId: input.councilId,
      name: input.name,
      role: input.role ?? "Member",
      isChair: false,
      joinedAt: now(),
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async getAgent(agentId: string): Promise<Agent | undefined> {
    return this.agents.get(agentId);
  }

  async listParticipants(councilId: string): Promise<Agent[]> {
    return [...this.agents.values()]
      .filter((a) => a.councilId === councilId)
      .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const sender = this.agents.get(input.fromAgentId);
    if (!sender || sender.councilId !== input.councilId) {
      throw new CoordinationError(
        `Agent "${input.fromAgentId}" is not a member of council "${input.councilId}".`,
      );
    }

    const toAgentId = input.toAgentId ?? null;
    if (toAgentId !== null) {
      const recipient = this.agents.get(toAgentId);
      if (!recipient || recipient.councilId !== input.councilId) {
        throw new CoordinationError(
          `Recipient "${toAgentId}" is not a member of council "${input.councilId}".`,
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
      fromAgentId: sender.id,
      fromName: sender.name,
      toAgentId,
      kind,
      content: input.content,
      createdAt: now(),
    };
    this.messages.get(input.councilId)!.push(message);
    return message;
  }

  async getMessages(
    councilId: string,
    agentId: string,
    sinceSeq = 0,
  ): Promise<Message[]> {
    const council = this.councils.get(councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${councilId}".`);
    }
    const agent = this.agents.get(agentId);
    if (!agent || agent.councilId !== councilId) {
      throw new CoordinationError(
        `Agent "${agentId}" is not a member of council "${councilId}".`,
      );
    }

    const all = this.messages.get(councilId) ?? [];
    return all.filter(
      (m) =>
        m.seq > sinceSeq &&
        (m.toAgentId === null ||
          m.toAgentId === agentId ||
          m.fromAgentId === agentId),
    );
  }
}
