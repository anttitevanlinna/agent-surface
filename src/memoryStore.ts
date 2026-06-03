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
  ABSTAIN,
  type CastVoteInput,
  type Council,
  CoordinationError,
  type CreateCouncilInput,
  type CreateProposalInput,
  type JoinCouncilInput,
  type Membership,
  type Message,
  type MessageKind,
  type Proposal,
  type RegisterSessionInput,
  type SendMessageInput,
  type Session,
  type Store,
  type Tally,
  type Vote,
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

/**
 * An option's canonical identity: trimmed and case-folded. This is the single
 * definition of "are these the same option?" — used both when declaring options
 * (to reject collisions and the reserved abstain) and when matching a ballot to
 * a declared option. Define it once here so those sites can never disagree.
 */
function optionKey(s: string): string {
  return s.trim().toLowerCase();
}

/** Trim, drop blanks, de-duplicate by identity, and validate a proposal's
 * options. Two options sharing a canonical identity (e.g. "Ship"/"ship") are a
 * collision and rejected, not silently merged — the proposer should disambiguate. */
function normalizeOptions(raw?: string[]): string[] {
  const provided = (raw ?? ["yes", "no"])
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const byKey = new Map<string, string>();
  for (const option of provided) {
    const key = optionKey(option);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      throw new CoordinationError(
        `Options "${existing}" and "${option}" are the same choice — option names must be distinct ignoring case.`,
      );
    }
    byKey.set(key, option);
  }

  const unique = [...byKey.values()];
  if (unique.length < 2) {
    throw new CoordinationError(
      "A proposal needs at least two distinct options.",
    );
  }
  if (unique.some((o) => optionKey(o) === ABSTAIN)) {
    throw new CoordinationError(
      `"${ABSTAIN}" is reserved and always available — don't list it as an option.`,
    );
  }
  return unique;
}

export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private sessionIdByName = new Map<string, string>(); // name -> sessionId (uniqueness)
  private councils = new Map<string, Council>();
  private memberships = new Map<string, Membership>(); // `${councilId}:${sessionId}`
  private messages = new Map<string, Message[]>(); // councilId -> ordered messages
  private seqByCouncil = new Map<string, number>(); // councilId -> last seq used
  private proposals = new Map<string, Proposal>(); // proposalId -> Proposal
  private votes = new Map<string, Map<string, Vote>>(); // proposalId -> (sessionId -> Vote)

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

    return this.appendMessage(sender, toSessionId, kind, input.content);
  }

  /** Append a message to a council's log, bumping the per-council seq. The
   * caller is responsible for membership/recipient/permission checks. */
  private appendMessage(
    sender: Membership,
    toSessionId: string | null,
    kind: MessageKind,
    content: string,
  ): Message {
    const seq = (this.seqByCouncil.get(sender.councilId) ?? 0) + 1;
    this.seqByCouncil.set(sender.councilId, seq);

    const message: Message = {
      id: shortId(),
      councilId: sender.councilId,
      seq,
      fromSessionId: sender.sessionId,
      fromName: sender.name,
      toSessionId,
      kind,
      content,
      createdAt: now(),
    };
    this.messages.get(sender.councilId)!.push(message);
    return message;
  }

  async createProposal(input: CreateProposalInput): Promise<Proposal> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const proposer = this.memberships.get(
      memberKey(input.councilId, input.sessionId),
    );
    if (!proposer) {
      throw new CoordinationError(
        `Session "${input.sessionId}" is not a member of council "${input.councilId}".`,
      );
    }
    const text = input.text.trim();
    if (text.length === 0) {
      throw new CoordinationError("A proposal must have text.");
    }
    const options = normalizeOptions(input.options);

    const proposal: Proposal = {
      id: shortId(),
      councilId: input.councilId,
      text,
      options,
      proposedBySessionId: proposer.sessionId,
      proposedByName: proposer.name,
      createdAt: now(),
    };
    this.proposals.set(proposal.id, proposal);
    this.votes.set(proposal.id, new Map());

    // Announce it in the feed so other members can discover and vote on it.
    this.appendMessage(
      proposer,
      null,
      "proposal",
      `Proposal ${proposal.id}: ${text}  [options: ${options.join(
        " / ",
      )} / ${ABSTAIN} — vote with cast_vote]`,
    );

    return proposal;
  }

  async getProposal(proposalId: string): Promise<Proposal | undefined> {
    return this.proposals.get(proposalId);
  }

  async castVote(input: CastVoteInput): Promise<Vote> {
    const council = this.councils.get(input.councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${input.councilId}".`);
    }
    const voter = this.memberships.get(
      memberKey(input.councilId, input.sessionId),
    );
    if (!voter) {
      throw new CoordinationError(
        `Session "${input.sessionId}" is not a member of council "${input.councilId}".`,
      );
    }
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.councilId !== input.councilId) {
      throw new CoordinationError(
        `No proposal "${input.proposalId}" in council "${input.councilId}".`,
      );
    }
    // Match the ballot to a declared option by canonical identity, then store
    // the option's own casing. Voting "ship" for a "Ship" option must count,
    // and the stored choice must equal the declared option so tally() (keyed on
    // the declared options) finds it. Same optionKey() used to declare options,
    // so matching and declaration can't drift apart.
    const key = optionKey(input.choice);
    const matched =
      key === ABSTAIN
        ? ABSTAIN
        : proposal.options.find((o) => optionKey(o) === key);
    if (matched === undefined) {
      throw new CoordinationError(
        `"${input.choice.trim()}" is not a valid choice. Pick one of: ${proposal.options.join(
          ", ",
        )}, or ${ABSTAIN}.`,
      );
    }

    const vote: Vote = {
      proposalId: proposal.id,
      sessionId: voter.sessionId,
      choice: matched,
      castAt: now(),
    };
    // Last vote wins: one ballot per session per proposal.
    this.votes.get(proposal.id)!.set(voter.sessionId, vote);
    return vote;
  }

  async tally(councilId: string, proposalId: string): Promise<Tally> {
    const council = this.councils.get(councilId);
    if (!council) {
      throw new CoordinationError(`No council with id "${councilId}".`);
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.councilId !== councilId) {
      throw new CoordinationError(
        `No proposal "${proposalId}" in council "${councilId}".`,
      );
    }

    const counts: Record<string, number> = {};
    for (const option of proposal.options) counts[option] = 0;
    let abstain = 0;

    const ballots = this.votes.get(proposalId) ?? new Map<string, Vote>();
    for (const vote of ballots.values()) {
      if (vote.choice === ABSTAIN) abstain += 1;
      else if (vote.choice in counts) counts[vote.choice] += 1;
    }

    const members = [...this.memberships.values()].filter(
      (m) => m.councilId === councilId,
    ).length;

    return {
      proposalId,
      text: proposal.text,
      counts,
      abstain,
      voted: ballots.size,
      members,
    };
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
