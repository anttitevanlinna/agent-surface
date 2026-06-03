# Task — deploy-prep for agent-surface (autonomous slice)

Source plan: `~/.claude/plans/ah-we-should-have-imperative-pudding.md` (Steps 0–6).
This file scopes the **send-off**: everything the agent can finish on its own,
stopping exactly where a human must act on the outside world.

## Scope in one breath

On a branch off `main`, make `agent-surface` deploy-ready: pin the Node runtime,
split `http.ts` into a testable `createApp` + a shared-secret bearer gate, add
graceful shutdown, cap the request body — then lay down the Render blueprint,
deploy docs, and a CI workflow. All in-repo, all verified by `npm test` + build.
Leave the two outward-facing verbs (pushing `main`, and the actual Render deploy +
external smoke test) for the human.

## In scope (autonomous — run to green)

- **Step 1** — pin Node: `engines` in `package.json`, new `.nvmrc` = `20`.
- **Step 2a** — extract `createApp(store, opts?)` into new `src/app.ts`; `http.ts`
  shrinks to build-store/read-env/listen/shutdown. No `listen` at import.
  `enableJsonResponse: true` on the transport. New `test/http.test.ts` via
  `app.listen(0)` + `fetch`, dual `Accept` + `Content-Type` headers.
- **Step 2b** — shared-secret bearer gate in new `src/auth.ts`
  (`crypto.timingSafeEqual`, JSON-RPC-shaped 401). Gate `POST /mcp` **and** the
  405 routes; never `/health`. Local = open-with-loud-warn when token unset;
  `RENDER` set + no token = **fail closed** (`process.exit(1)`).
  - **Read `docs/adr/0001` before writing this.** The bearer gate is *perimeter*
    auth: it authenticates the connection, not the per-call `session` argument.
    ADR-0001 lists exactly this as a **rejected alternative** ("orthogonal and
    complementary, not a substitute"). So it closes the public-spam problem and
    **nothing** of ADR-0001's per-session identity threats — **S1, S2, T1, E1, I1
    stay live by design** this milestone. Do **not** report "auth: done"; the auth
    summary must name those surviving threats. See
    `observations/rule-auth-bearer-gate-is-perimeter-only.md`.
- **Step 3** — graceful `SIGTERM`/`SIGINT` shutdown + force-exit timeout; fix the
  misleading localhost log line; comment the `0.0.0.0` bind.
- **Step 4** — `express.json({ limit: "256kb" })` per-route on `/mcp`, **after**
  `requireBearer`; terminal JSON-RPC error middleware reshapes the 413 to match
  the 401/405 envelope.
- **Step 5** — new `render.yaml` (web/node/free/frankfurt, `autoDeploy: false`,
  commented-out `databases:` + `DATABASE_URL` seam), new `.env.example`, README
  "Deploy" section; delete the stray root `DEPLOY_PLAN.md`.
- **Step 5b** — new `.github/workflows/ci.yml` (Node 20: `npm ci` → build → test).
  Create the file; do **not** push to verify (push is human work).

## Out of scope (human verbs — present results, then wait)

- **Step 0 push** — agent may reconcile the `main`/`origin/main` divergence
  locally and show `git log --oneline`, but **does not push**. Branch off `main`
  for all work; never commit to `main` directly.
- **Step 6** — Render deploy + external smoke test. Needs the dashboard, the
  `MCP_AUTH_TOKEN` secret, and a live URL. Hand back a ready branch; the human
  triggers the deploy.

## The interaction that proves the work (don't get it wrong)

Step 4's correctness is **defined by** Step 2b's ordering: the body cap mounts
**after** the bearer gate, so an unauthenticated oversized body never reaches the
parser, and the 413 must be reshaped into the **same** JSON-RPC error envelope as
the 401 and 405. Gate-after-parse, or letting finalhandler emit HTML, is silently
wrong on both steps.

## Done (autonomous slice) — evidence, not eyeballs

A config artifact is done only when something *ran* it. Each item below must show
the evidence named, not a read-through (see the `CLAUDE.local.md` rule of the same
name):

- `npm test` green: 26 existing + ~9 new HTTP/auth/body tests; each new test
  watched failing first (test-before-code is literal here).
- `npm run build` (+ typecheck) clean.
- **Auth summary names the surviving ADR-0001 threats** (S1, S2, T1, E1, I1) — the
  bearer gate is not reported as closing them. (See Step 2b.)
- **Env coverage proven:** `grep -ro "process\.env\.[A-Z_]*" src/` and assert every
  name appears in `.env.example` and `render.yaml`. Paste the diff of the two sets.
- **Boot posture proven:** run `RENDER=1` with no token → observe `exit(1)`; run
  `RENDER=1` with a token → observe a gated boot. Paste both exit codes (this and
  the constant-time compare are verify-by-hand-with-evidence, not green tests).
- **Blueprint↔scripts proven:** byte-match `render.yaml` `buildCommand`/`startCommand`
  against `package.json` scripts; confirm `startCommand` runs the `dist/http.js`
  the refactor still produces.
- Branch off `main`, smallest-coherent commits per the plan's git rhythm; full
  `git diff` shown before each commit. Two human verbs (push, deploy) untouched.

## Hard rules carried in

- Test-before-fix is literal: watched-failing test, then code.
- Don't weld the 2a refactor and the 2b security change into one commit.
- One state-changing external action per request; both live behind the human gate
  here, so the agent makes none.
- Constant-time compare is a structural guarantee (code review + comment), not a
  green test — do not claim coverage it can't have.

---

## Run coordinates (do not rewrite or remove)

- **Branch:** `m4/deploy-prep`
- **Transcript:** `/Users/anttitevanlinna/.claude/projects/-Users-anttitevanlinna-Projects-agent-surface/b58425a0-abca-4da5-96e7-ad68bb0558b1.jsonl`
