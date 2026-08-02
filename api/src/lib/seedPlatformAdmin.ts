/**
 * Optional platform-admin bootstrap.
 * Only runs when SEED_PLATFORM_ADMIN_EMAIL + SEED_PLATFORM_ADMIN_PASSWORD are set.
 * Leave unset in production unless you intentionally want a bootstrap admin.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from './logger';

export async function seedPlatformAdmin(conn: PoolConnection): Promise<void> {
  const emailRaw = env.SEED_PLATFORM_ADMIN_EMAIL?.trim();
  const password = env.SEED_PLATFORM_ADMIN_PASSWORD;
  if (!emailRaw || !password) {
    return;
  }

  const email = emailRaw.toLowerCase();
  const name = env.SEED_PLATFORM_ADMIN_NAME?.trim() || 'Platform Admin';
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  const [rows]: any = await conn.query(
    'SELECT id FROM tbl_user WHERE email = ? LIMIT 1',
    [email]
  );
  const existing = rows?.[0];

  if (existing?.id) {
    await conn.query(
      `UPDATE tbl_user
          SET passwordHash = ?,
              name = COALESCE(name, ?),
              emailVerified = 1,
              isPlatformAdmin = 1,
              authProvider = 'password',
              emailVerifyToken = NULL,
              emailVerifyExpiresAt = NULL
        WHERE id = ?`,
      [passwordHash, name, existing.id]
    );
    logger.info({ email }, 'Seeded platform admin updated');
    return;
  }

  const id = crypto.randomUUID();
  await conn.query(
    `INSERT INTO tbl_user
      (id, email, passwordHash, name, plan, emailVerified, authProvider, isPlatformAdmin)
     VALUES (?, ?, ?, ?, 'FREE', 1, 'password', 1)`,
    [id, email, passwordHash, name]
  );
  logger.info({ email, id }, 'Seeded platform admin created');
}
