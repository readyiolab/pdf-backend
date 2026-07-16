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
