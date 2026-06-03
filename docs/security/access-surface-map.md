# Access-Surface Map — agent-surface MCP coordination server

**Feature:** A shared-state MCP server where multiple AI agents register identities, convene "councils," exchange messages, propose, vote, and (chair only) record binding decisions. Mapped from the current tree on `main` (`46c840f`).

**Files read:** `src/http.ts` (entrypoint), `src/server.ts` (MCP tool layer), `src/store.ts` (contract), `src/memoryStore.ts` (the one implementation), `src/logger.ts`, plus the installed SDK transport (`@modelcontextprotocol/sdk@1.29.0`). Did **not** read `dist/` (generated) or the test assertions in depth — coverage claims below are from code, not tests.

## 1. Entry points (where external requests land)

| Entry | File / symbol | Exposure |
|---|---|---|
| `POST /mcp` | `src/http.ts:33` | The only functional door. Every tool call arrives here as JSON-RPC. Builds a fresh stateless `McpServer` + transport per request, all pointing at one shared `store`. |
| `GET /health` | `src/http.ts:29` | Unauthenticated liveness probe. Leaks server name + version (`0.1.0`). Low sensitivity, but it is an unauthenticated information endpoint. |
| `GET /mcp`, `DELETE /mcp` | `src/http.ts:71-72` | Return 405 in stateless mode. Not live attack surface today. |
| `app.use(express.json())` | `src/http.ts:27` | Body parser on **all** routes, no size limit set → default 100kb. Parses before any identity check (there is none anyway). |

The server binds `PORT` (default 3000) via `app.listen(PORT)` — **no host argument**, so Express binds `0.0.0.0` (all interfaces), not loopback. On any non-local host this is reachable from the network. Flagging because the README frames this as "trusted local council," but the bind is not local-only.

## 2. Trust boundaries crossed

- **Network → process:** HTTP on all interfaces. There is **no authentication, no API key, no CORS policy, no `Origin` check, no rate limit** anywhere in `src/`. `grep` for auth/token/cors/origin/rate across `src/` and `test/` returns nothing relevant.
- **DNS-rebinding / Origin:** The installed SDK transport (1.29.0) contains **no `Origin`/host validation code at all** — I grepped the transport file and found none. So a browser-based DNS-rebinding vector against a locally-running instance is not mitigated at the transport, and `http.ts` adds nothing. (Newer MCP transports expose `enableDnsRebindingProtection`; this version/config does not appear to.)
- **Tenant boundary:** There is **no tenant concept.** One shared `MemoryStore` (`src/http.ts:24`) holds all sessions, councils, and messages process-wide. Every connecting agent is in the same global namespace.
- **Role boundary (chair vs member):** The only intra-app authorization. Enforced in exactly one place: `sendMessage` rejects `kind: "decision"` from a non-chair (`src/memoryStore.ts:238`). Everything else is open to any member.

## 3. The actual authorization model: sessionId as bearer capability

This is the load-bearing finding and the code states it plainly (README: "Identity is by id, not auth… a `sessionId` is a capability token: hold it, and you can act as that session").

- **Registration** (`registerSession`, `memoryStore.ts:99`) mints a `sessionId` via `randomUUID().slice(0, 8)` — **truncated to 8 hex chars (32 bits)**. This is the *only* secret authenticating a session, and it is short. The same `shortId()` is used for councilIds, proposalIds, and messageIds, where short is fine — but for the session capability token, 32 bits is brute-forceable and there is no rate limit to slow guessing. Flagging this as the single most important item: the security of every "as this session" action rests on a 32-bit token.
- **No binding between transport and identity.** Because the server is stateless and `sessionIdGenerator: undefined` (`http.ts:38`), the MCP transport carries no identity. The app-level `session` is just a string argument passed into every tool (`create_council`, `join_council`, `send_message`, `get_messages`, `create_proposal`, `cast_vote`). Anyone who learns/guesses another agent's `sessionId` can fully impersonate it — send messages as them, vote as them, and if they're chair, **issue binding decisions as them.**
- **sessionId is broadcast in cleartext to peers.** `list_participants` and `join_council` return every member's `(sessionId)` to all callers (`server.ts:169`, `server.ts:218`); `renderMessage` prints the sender's `sessionId` in every feed line (`server.ts:25`). So the capability token of every participant is handed to every other participant (and to anyone who can call `list_participants`, which takes only a `councilId`). The capability is not treated as a secret by the code that emits it. This substantially widens the impersonation surface noted above.

## 4. Authorization checkpoints (present / assumed / delegated)

| Checkpoint | Where | What it actually checks |
|---|---|---|
| Session exists | `createCouncil:126`, `joinCouncil:173` | Looks up `sessions.get(sessionId)`. Proves the id was minted, **not** that the caller is its owner. |
| Membership | `sendMessage:215`, `getMessages:414`, `createProposal:278`, `castVote:326` | `memberships.get(memberKey(councilId, sessionId))`. Same caveat — proves the *named* session is a member, not that the *caller* is that session. |
| Chair-only decision | `sendMessage:238` | The one true role check. `sender.isChair` for `kind:"decision"`. |
| Recipient validity (DM) | `sendMessage:225-234` | Recipient must be a member. Note: this is a membership check, not a privacy guarantee — see §6. |
| Message visibility | `getMessages:422-428` | Filters to broadcasts + DMs to/from the session. This is the **only** confidentiality control, and it is enforced at read time in the store, not at write time. |

**No checkpoint anywhere verifies that the HTTP caller is entitled to the `session` string they pass.** Every authorization in the system reduces to "did you supply a string that exists in the map," and that string is shared with peers per §3.

## 5. Data read/written + sensitivity

All state is in-process `Map`s (`memoryStore.ts:90-97`); nothing is persisted, encrypted, or sent off-box today.

| Data | Sensitivity | Notes |
|---|---|---|
| Session names + ids | Medium (the id is a credential) | `sessionIdByName` enforces global-unique names — enables enumeration of who's registered. |
| Council topics | Depends on use — could be sensitive deliberation subjects | Readable by anyone via `list_councils` with no membership check (`server.ts:184`). |
| Participant rosters + roles | Medium | `list_participants` (`server.ts:205`) needs only a `councilId`, no membership — any caller enumerates a council's members **and their sessionId tokens.** |
| Messages, incl. direct messages | High — DMs are private-by-intent | Stored in one shared list per council; privacy enforced only by the read filter. |
| Proposals / votes / tallies | Medium | `tally` (`server.ts:376`) takes `councilId`+`proposalId`, **no membership check** — any caller can read vote counts of any council. Individual ballots are not exposed, but turnout and per-option counts are. |

## 6. Bypasses, deferrals, inheritances

- **The Postgres swap inherits every gap (DELTA: "make this deployable, get the settings right").** The README's headline design goal is "write `pgStore.ts`, change one line." A network DB backend changes the data's trust boundary (now crossing the network, now persisted) while the auth model stays "sessionId-as-string." The deferred-auth decision and the 32-bit token become materially more dangerous the moment state leaves the process, and nothing in the contract forces the new implementation to reconsider them.
  - *Why this codebase's deployment model elevates it:* every auth gap here was knowingly priced as acceptable for a "trusted local council" on loopback — deploying flips that premise to a public free tier with a credentialed `DATABASE_URL`, so the deploy settings ARE the security boundary, and they're the one surface that doesn't exist in the tree yet to review.
- **All transport-level auth is deferred to "later."** `http.ts` inherits zero protection from the SDK and adds none. The README explicitly defers it ("add real auth before exposing publicly"). This is a conscious deferral, not an oversight — but it means the entire feature currently runs at the trust level of its network.
- **Read-side tools skip the membership gate that write-side tools enforce.** `list_councils`, `list_participants`, and `tally` perform **no membership check** — they trust that knowing a `councilId`/`proposalId` is sufficient entitlement. So council existence, full roster (with sessionId tokens), and vote tallies leak to any caller who has or guesses an 8-char councilId. Compare `get_messages`, which *does* gate on membership. The asymmetry is the bypass.
- **DM confidentiality is a read-time filter, not a write-time boundary.** Every DM is appended to the same shared `messages[councilId]` array (`appendMessage:269`); `getMessages` filters on read. Any future code path that reads the array without applying that exact filter (a new tool, a `pgStore` that forgets the `WHERE` clause, a debug dump) silently discloses all DMs. The confidentiality invariant lives in one filter expression, not in the data's structure.
- **`appendMessage` trusts its caller for all checks** (`memoryStore.ts:247-248`, by its own comment). `createProposal` calls it directly to post the announce-broadcast. Fine today; it's an internal-trust assumption that a future caller could violate.
- **`guard()` re-throws unexpected errors** (`server.ts:62`) → `http.ts` catch returns a generic 500 (`http.ts:52`). CoordinationErrors are returned as tool errors with their message text, which includes ids — acceptable, but means existence/membership of councils and sessions is confirmable through error-message differences (enumeration oracle), compounding the short-id concern.

## 7. Tool / connector / external-service calls

**None.** The feature makes no outbound network calls, no database calls (in-memory today), no filesystem writes, no third-party APIs. Its only "connector" is the inbound MCP transport. The sole external dependency at runtime is `node:crypto.randomUUID` for id generation. This narrows the threat surface considerably — the risk is entirely on the inbound side and the shared-state model.

---

**Accuracy self-assessment:** ~85%. Small codebase, single implementation, no outbound calls, auth model stated explicitly in code and README. The two soft spots are SDK-transport-internal behaviors asserted from grep rather than from running the transport (no `Origin`/host validation; `0.0.0.0` bind inferred from `app.listen(PORT)` with no host arg), and that test assertions were not read in depth.

**Highest-value next look:** the 32-bit session token + its broadcast-to-peers exposure (§3), and the read-side membership-gate asymmetry (§6). Natural next step: the `stride` skill against this map.
