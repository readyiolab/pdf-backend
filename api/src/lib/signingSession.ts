import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Short-lived session proving a signer passed their identity challenge.
 *
 * ── Why a separate key domain ──────────────────────────────────────────────
 * These tokens are signed with a key DERIVED from JWT_SECRET, not JWT_SECRET
 * itself. If both were signed with the same key, a signing-session token would
 * be a structurally valid user token: it would sail through `verifyToken()` in
 * authMiddleware, and the only thing standing between a signer and an
 * authenticated account session would be the `tbl_user` lookup failing on a
 * missing `userId` claim. That is a claim check away from privilege escalation,
 * and claim checks get refactored.
 *
 * With separate keys the two token types are cryptographically incapable of
 * validating against each other's verifier — the failure mode is a signature
 * mismatch, not a logic bug someone can reason their way around.
 *
 * HKDF-style derivation from the existing secret keeps this config-free: no new
 * env var to generate, rotate, or forget in production.
 */
const SIGNING_SESSION_SECRET = crypto
  .createHmac('sha256', env.JWT_SECRET)
  .update('pdfproduct:signing-session:v1')
  .digest('hex');

/**
 * Deliberately short. This is the window in which a signer can submit after
 * proving who they are; it is not a login. Long enough to read a contract and
 * sign it, short enough that a session left open on a shared machine expires.
 */
const SESSION_TTL = '2h';

export interface SigningSessionClaims {
  recipientId: string;
  documentId: string;
}

interface DecodedSigningSession extends SigningSessionClaims {
  iat: number;
  exp: number;
}

export function signSigningSession(claims: SigningSessionClaims): string {
  return jwt.sign(claims, SIGNING_SESSION_SECRET, {
    expiresIn: SESSION_TTL,
    jwtid: crypto.randomUUID(),
  });
}

export function verifySigningSession(token: string): DecodedSigningSession {
  return jwt.verify(token, SIGNING_SESSION_SECRET) as DecodedSigningSession;
}

/**
 * Generates the unguessable secret embedded in a signing link.
 *
 * 32 bytes from a CSPRNG → 256 bits of entropy, 64 hex chars (matching the
 * CHAR(64) column). This is a bearer credential to a legal document with no
 * password behind it, so it must be infeasible to guess or enumerate — never
 * derive this from a UUID, timestamp, or Math.random.
 */
export function generateSigningToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison for token lookups done in application code.
 *
 * The token is UNIQUE-indexed so lookups go through MySQL, but any place that
 * compares two tokens in JS must not use `===`: string equality short-circuits
 * on the first differing byte and leaks a timing signal.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
