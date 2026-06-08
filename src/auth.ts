/**
 * Perimeter bearer gate — and ONLY a perimeter gate.
 *
 * This authenticates the *connection* to /mcp with a single shared secret. It is
 * deliberately the transport-level auth that ADR-0001 lists as a REJECTED
 * alternative to action-layer identity: it does not bind the per-call `session`
 * argument, so once a caller is past this gate it can still name any sessionId.
 * ADR-0001's per-session threats S1, S2, T1, E1, I1 stay LIVE by design this
 * milestone. Never read a green gate as "auth done"
 * (see observations/rule-auth-bearer-gate-is-perimeter-only.md).
 *
 * What it legitimately closes: "anyone on the public internet can register/spam
 * the server" — real hardening for going live.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** -32001: a JSON-RPC application error code for an unauthenticated request. */
const UNAUTHORIZED = -32001;

/**
 * Constant-time secret comparison. We compare every byte regardless of an early
 * mismatch so the time taken does not leak how much of the token was guessed.
 * `timingSafeEqual` throws on a length mismatch, so a differing length short-
 * circuits to false — that leaks token *length*, which is not the secret and is
 * the standard accepted trade-off.
 */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Express middleware factory. Returns a guard that requires
 * `Authorization: Bearer <token>` to equal `expectedToken`. On failure it emits
 * a 401 in the SAME JSON-RPC envelope shape as the 405 and the 413, so a client
 * never has to parse HTML to learn it was rejected.
 */
export function requireBearer(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    if (presented === "" || !secretEquals(presented, expectedToken)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: UNAUTHORIZED, message: "Unauthorized." },
        id: null,
      });
      return;
    }
    next();
  };
}
