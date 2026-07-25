import { redis } from './redis';

// Short-TTL cache of the minimal user record used on every authenticated request
// (id + plan + emailVerified). Keeps auth off the MySQL hot path. TTL is deliberately
// short so a deleted/downgraded/verified account can't linger long; plan changes
// also invalidate explicitly (see webhooks.service).
const PREFIX = 'user:auth:';
const TTL_SECONDS = 30;

export interface CachedUser {
  id: string;
  plan: 'FREE' | 'PRO';
  emailVerified: boolean;
}

export async function getCachedUser(id: string): Promise<CachedUser | null> {
  const raw = await redis.get(`${PREFIX}${id}`);
  return raw ? (JSON.parse(raw) as CachedUser) : null;
}

export async function setCachedUser(user: CachedUser): Promise<void> {
  await redis.set(`${PREFIX}${user.id}`, JSON.stringify(user), 'EX', TTL_SECONDS);
}

export async function invalidateUser(id: string): Promise<void> {
  await redis.del(`${PREFIX}${id}`);
}
