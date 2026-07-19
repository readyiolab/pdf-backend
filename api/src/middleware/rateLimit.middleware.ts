import rateLimit, { Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';

/**
 * Builds a Redis-backed store so limits are shared across all API replicas
 * and survive restarts (the default in-memory store is per-process only).
 */
function redisStore(prefix: string) {
  return new RedisStore({
    sendCommand: (...args: string[]) => (redis as any).call(...args),
    prefix,
  });
}

const common: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  // If Redis is down (e.g. connection error, or provider quota exceeded), let
  // requests through rather than 500ing all traffic on a rate-limiter outage.
  passOnStoreError: true,
};

// General API limiter: generous, keyed per IP.
export const rateLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  store: redisStore('rl:general:'),
  message: {
    status: 'error',
    message: 'Too many requests, please try again in a few minutes.',
  },
});

// Strict limiter for auth endpoints — brute-force protection.
export const authRateLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 login/register attempts per IP per 15 min
  store: redisStore('rl:auth:'),
  skipSuccessfulRequests: true, // only count failed attempts against the limit
  message: {
    status: 'error',
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
  },
});

/**
 * Limiter for the signature designer's autosave path.
 *
 * The general limiter (300 per 15 min) is sized for human-paced navigation and
 * would throttle a legitimate design session: the designer debounces saves but
 * still fires one per edit burst, and dragging a dozen fields across pages can
 * outpace 20 req/min. This is keyed per IP like the others and still bounded —
 * it's a wider window for a known-chatty endpoint, not an exemption.
 */
export const designerRateLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 90, // ~1.5 saves/s sustained
  store: redisStore('rl:designer:'),
  message: {
    status: 'error',
    message: 'Too many edits too quickly. Your work is saved — please slow down.',
  },
});

/**
 * Limiter for the public, unauthenticated signing routes.
 *
 * These are the only endpoints reachable with no account at all, and the token
 * in the URL is a bearer credential to a legal document. The cap is sized for a
 * human signing a document (open, verify, submit) rather than for someone
 * walking the token space.
 */
export const signingRateLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 100,
  store: redisStore('rl:sign:'),
  message: {
    status: 'error',
    message: 'Too many requests. Please wait a few minutes and try again.',
  },
});

/**
 * Deliberately tight limiter for OTP issue/verify.
 *
 * A 6-digit code is only a million possibilities. The per-recipient attempt
 * counter in otpService is the primary defence, but it is keyed on the
 * recipient — this one is keyed on IP, which also blunts someone spraying codes
 * across many links, and stops OTP issuance being used to spam a victim's inbox
 * (or burn the Gmail sending quota) on demand.
 */
export const otpRateLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 15,
  store: redisStore('rl:otp:'),
  message: {
    status: 'error',
    message: 'Too many verification attempts. Please wait a few minutes.',
  },
});

/**
 * Limiter for the AI endpoints.
 *
 * AI calls are slow (a model round trip) and each one costs money, so this is
 * tighter than the general limiter — it caps burst abuse on top of the monthly
 * credit quota, which is the real spend guardrail. Keyed per IP.
 */
export const aiRateLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 10,
  store: redisStore('rl:ai:'),
  message: {
    status: 'error',
    message: 'Too many AI requests. Please wait a moment and try again.',
  },
});

// Polling-friendly limiter for job status reads (called frequently by clients).
export const pollRateLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 120, // ~2 req/s per IP
  store: redisStore('rl:poll:'),
  message: {
    status: 'error',
    message: 'Too many status checks, slowing down.',
  },
});
