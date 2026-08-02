import { redis } from './redis';

// Short-TTL cache of the minimal user record used on every authenticated request
// (id + plan + emailVerified + org storage context). Keeps auth/org lookup off
// the MySQL hot path. TTL is deliberately short so a deleted/downgraded/verified
// account can't linger long; plan / BYOC changes also invalidate explicitly.
const PREFIX = 'user:auth:';
const TTL_SECONDS = 30;

export interface CachedUser {
  id: string;
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  emailVerified: boolean;
  /** null = personal / platform storage */
  organizationId: string | null;
  /** Active BYOC binding id, or null when using platform Spaces */
  storageBindingId: string | null;
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
