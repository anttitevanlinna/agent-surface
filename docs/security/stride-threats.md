# STRIDE Threat List — agent-surface MCP coordination server

Derived from the access-surface map (`access-surface-map.md`) for this feature.
Threats walked across all six STRIDE categories, each cited to the map section it maps to,
each with a severity **for this feature** (a stateless, in-memory, currently-loopback-intended
MCP council server with no transport auth). Severities are not recommendations — the engineer
picks what to harden.

---

## High-severity threats for this feature

- **S1 — Session impersonation via 32-bit brute-forceable token** (§3)
- **S2 — Impersonation via broadcast sessionId capability** (§3)
- **T1 — Forged actions as another session (vote/message)** (§3, §4)
- **E1 — Binding decisions issued as a chair you impersonated** (§2, §3)
- **I1 — Capability tokens leaked to all peers / any caller** (§3, §5)
- **I3 — DM disclosure via single read-time filter invariant** (§4, §6)
- **E3 — Read-side membership-gate asymmetry (council/roster/tally leak)** (§5, §6)

---

## Spoofing

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| S1 | **32-bit session token is brute-forceable.** `sessionId = randomUUID().slice(0,8)` (32 bits) is the only secret authenticating a session, with no rate limit to slow guessing. Guess it and you are that session. | §3 | High |
| S2 | **sessionId broadcast in cleartext to peers.** `list_participants`, `join_council`, and `renderMessage` emit every member's `sessionId` to any caller. The capability is handed to everyone, so spoofing needs no guessing — just observation. | §3 | High |
| S3 | **Name enumeration aids targeted spoofing.** Global-unique session names (`sessionIdByName`) let an attacker enumerate who is registered and pick a target to impersonate once a token is obtained. | §5 | Medium |
| S4 | **No transport↔identity binding; DNS-rebinding vector.** Stateless transport carries no identity and has no Origin/host validation, so a browser-based caller could spoof a request origin against a local instance. | §2 | Medium |

## Tampering

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| T1 | **Forge actions as another session.** Holding/guessing a sessionId lets an attacker send messages, cast votes, and create proposals attributed to that session — tampering with the council's record. | §3, §4 | High |
| T2 | **Vote tally manipulation.** With a member token an attacker can cast votes as others, skewing `tally` outcomes that drive binding decisions. | §3, §5 | Medium |
| T3 | **Unbounded request body.** `express.json()` has no size limit (defaults to 100kb) and parses before any check — large/crafted bodies parsed indiscriminately. | §1 | Low |
| T4 | **Internal-trust callers bypass checks.** `appendMessage` trusts its caller for all checks; a future internal caller (or pgStore) could write messages without the intended gating. | §6 | Low |

## Repudiation

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| R1 | **No accountability binding for actions.** Because any holder of a sessionId can act as it and tokens are shared, an actor can plausibly deny an action ("someone else had my token") — no proof ties an action to a unique caller. | §3, §4 | Medium |
| R2 | **No persistent/tamper-evident audit log.** All state is in-process `Map`s; nothing is persisted. Actions (decisions, votes) leave no durable record to attribute or dispute later. | §5, §7 | Medium |
| R3 | **Chair decisions are repudiable post-impersonation.** A binding `kind:"decision"` issued via an impersonated chair cannot be distinguished from a legitimate one. | §2, §3 | Medium |

## Information disclosure

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| I1 | **Capability tokens disclosed to all peers and any caller.** Same emission as S2, but framed as a confidentiality breach: every participant's credential is exposed to anyone who can call `list_participants` (needs only a councilId). | §3, §5 | High |
| I3 | **DM confidentiality rests on one read-time filter.** Every DM is appended to a shared per-council array; privacy is enforced only by the `getMessages` filter. Any path that reads the array without that exact filter (new tool, pgStore missing a WHERE, debug dump) discloses all DMs. | §4, §6 | High |
| I2 | **Read-side leaks: council topics, rosters, tallies.** `list_councils`, `list_participants`, and `tally` perform no membership check — council existence, full rosters (with tokens), and vote counts leak to any caller with/guessing an 8-char id. | §5, §6 | Medium |
| I4 | **Error-message enumeration oracle.** CoordinationError messages confirm existence/membership of councils and sessions via differing text, compounding the short-id guessing concern. | §6 | Medium |
| I5 | **`/health` leaks server name + version.** Unauthenticated endpoint discloses `0.1.0`, aiding version-specific targeting. | §1 | Low |

## Denial of service

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| D1 | **No rate limiting anywhere.** No rate limit on registration, tool calls, or token guessing — enables brute-force, request flooding, and resource exhaustion. | §2 | Medium |
| D2 | **Unbounded in-memory growth.** All state is in-process `Map`s with no eviction/persistence; unlimited registrations, councils, and messages can exhaust process memory. | §5 | Medium |
| D3 | **Bound to all interfaces (`0.0.0.0`).** `app.listen(PORT)` with no host arg exposes the service network-wide on non-local hosts, widening the DoS (and every other) reachability beyond the "trusted local" premise. | §1 | Medium |
| D4 | **Body-parse cost on every route.** `express.json()` runs before any identity check (there is none), so unauthenticated callers force parse work. | §1 | Low |

## Elevation of privilege

| ID | Threat | Maps to | Severity |
|---|---|---|---|
| E1 | **Impersonate a chair to issue binding decisions.** The one true role check (`sender.isChair` for `kind:"decision"`) is gated only by the sessionId string; impersonating a chair grants the highest privilege in the system — recording binding decisions. | §2, §3 | High |
| E3 | **Read-side membership-gate asymmetry = privilege bypass.** Write-side tools gate on membership; `list_councils`/`list_participants`/`tally` do not. Knowing a councilId substitutes for membership entitlement — a privilege the caller was never granted. | §5, §6 | High |
| E2 | **Deferred/inherited auth in the Postgres swap.** The "change one line" pgStore inherits every gap while moving state across the network and persisting it; deploy settings become the security boundary, and the 32-bit token + sessionId-as-string model become materially more dangerous off-box. | §6 | Medium |
| E4 | **No tenant boundary.** One shared `MemoryStore` holds all sessions/councils/messages process-wide; any connecting agent is in the same global namespace, so cross-"tenant" reach is the default, not an escalation that must be earned. | §2 | Medium |
