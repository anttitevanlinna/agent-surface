# 0001 — Bind session identity to a secret credential, not a published id

Status: Accepted
Date: 2026-06-03

## Context

An agent calls `list_participants` on a council it found by guessing an 8-char
id, reads the chair's `sessionId` straight out of the roster, and from then on
*is* the chair — it issues a binding `decision` the council treats as
authoritative, and the real chair cannot prove they didn't make it. This needs
no brute-force and no exploit: the server publishes the credential and then
honors it.

Root cause (surface map §3): the system authenticates every action by "did you
present a string that exists," never "are you the party that string belongs
to." The acting-credential and the displayed-identifier are the same value, and
read tools (`list_participants`, `join_council`, every message line) broadcast
that value to peers. A STRIDE pass put seven threats at High; six of the seven
trace to this one root wearing different hats — it starts as Information
disclosure (the token leaks), executes as Spoofing (acting as another
identity), and lands as Elevation of privilege (a member becomes chair, the one
privilege boundary).

The load-bearing class is **Spoofing**. Fixing the disclosure alone leaves the
32-bit token brute-forceable; making identity unforgeable stops both the leak
and the brute-force from mattering, because holding the string is no longer
sufficient to *be* the session.

## Decision

Gate every action on a **secret credential the caller holds and the roster
never reveals**. Split today's single `sessionId` string into two values:

- a **public member handle** — safe to broadcast in rosters, participant lists,
  and message lines; used only to *name* a participant;
- a **secret auth credential** — presented per request, never returned by any
  read tool; used only to *authenticate* the actor.

Authorization checks the secret; display surfaces only ever emit the handle.
Possession of a printed identifier stops being proof of identity.

## Consequences

Protects: disarms five of the seven High threats at once — session
impersonation via brute-force (S1) and via broadcast (S2), forged actions as
another session (T1), impersonated-chair binding decisions (E1), and capability
leakage to peers (I1) — because each assumes the acting-credential and the
displayed-identifier are the same value, and they no longer are.

Does **not** protect: two Highs have a different root (surface map §6) and
survive this change — DM confidentiality resting on a single read-time filter
(I3), and read-side tools skipping the membership gate that write-side tools
enforce (E3). They need their own decisions; this ADR must not be read as
closing them.

Costs:
- *Latency:* negligible — one extra secret comparison per request, no network
  hop added.
- *Complexity:* the `Store` contract and every tool signature now carry two
  identity fields instead of one; the split must be honored at every call site,
  and the invariant "never emit the secret from a read path" has to be enforced
  by review/test, not just convention.
- *Operational burden:* clients now hold a secret and must transmit it on each
  call; the secret needs real entropy (the current 32-bit `slice(0,8)` is not
  enough for a credential) and a rotation/revocation story once the planned
  `PgStore` persists it off-process.

## Alternatives considered

- **Just widen the token (full UUID, no split).** Removes the brute-force
  vector (S1) but not the broadcast one (S2/I1) — the roster still prints the
  credential, so a longer secret is still handed to every peer. Treats the
  symptom, not the root.
- **Stop broadcasting the `sessionId` (close the disclosure only).** Plugs the
  leak (I1) but leaves the 32-bit token brute-forceable and identity still
  bearer-shaped; the incident story survives, just slower. Fixes the I, not the
  load-bearing S.
- **Transport-level auth (API key / mTLS in front of the server).** Authenticates
  the *connection* but not the per-action `session` argument inside it — one
  authenticated client can still act as any session it can name. Orthogonal and
  complementary, not a substitute for binding identity at the action layer.
