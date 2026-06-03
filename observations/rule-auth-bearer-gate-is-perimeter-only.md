# The `MCP_AUTH_TOKEN` bearer gate does NOT satisfy ADR-0001

**Status:** rule · **Concerns:** auth, the deploy milestone, ADR-0001
**Verified against:** `docs/adr/0001-bind-identity-with-secret-credential.md:79-82`,
`docs/security/stride-threats.md:11-17` (threat IDs read, not paraphrased).

## The collision

ADR-0001 (Accepted) decides identity must be split into a public **handle** and a
secret **auth credential** bound *at the action layer* (the per-call `session`
argument). It explicitly lists transport/connection-level auth as a **rejected
alternative**, verbatim:

> **Transport-level auth (API key / mTLS in front of the server).** Authenticates
> the *connection* but not the per-action `session` argument inside it — one
> authenticated client can still act as any session it can name. Orthogonal and
> complementary, **not a substitute** for binding identity at the action layer.

The deploy milestone's `MCP_AUTH_TOKEN` bearer gate **is exactly that rejected
alternative.** A single server-wide bearer token authenticates the *connection*
to `/mcp`; once inside, the caller still names any `sessionId` it likes.

## What the gate does and does not close

- **Closes (legitimately):** the "anyone on the public internet can register/spam"
  perimeter problem. This is real, useful hardening for going live. Keep it.
- **Closes NOTHING of ADR-0001's per-session identity threats.** These remain
  **live by design** this milestone (all High in `stride-threats.md`):
  - **S1** — 32-bit `sessionId` is brute-forceable.
  - **S2** — `sessionId` broadcast in cleartext to all peers.
  - **T1** — forge actions (vote/message) as another session.
  - **E1** — impersonate a chair to issue binding decisions.
  - **I1** — capability tokens disclosed to all peers / any caller.

The two are orthogonal layers, not substitutes — exactly as the ADR says.

## Rule for any auth work here

1. Read `docs/adr/0001` **before** touching identity/auth/the `Store` contract.
2. Never report the bearer gate as "auth: done." It is *perimeter* auth. Any
   auth summary must **name the surviving threats** (S1, S2, T1, E1, I1) so a
   green test suite is not mistaken for closed identity threats.
3. The thing that would satisfy ADR-0001 is the handle/credential split at the
   action layer — a separate, later milestone, not this one.
