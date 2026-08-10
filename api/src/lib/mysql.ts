import type { Pool, PoolConnection } from 'mysql2/promise';
import { logger } from './logger';
import { ensureColumn, ensureIndex } from './ddl';
import { initializeSigningSchema } from './signingSchema';
import { initializeByocSchema } from './byocSchema';
import { initializeLetterSchema } from './letterSchema';
import { initializeDiagramSchema } from './diagramSchema';
import { seedPlatformAdmin } from './seedPlatformAdmin';
import { db } from './database';

export { db } from './database';

/**
 * Boots the shared Database pool and runs DDL. Prefer importing `db` for
 * select / insert / update / query helpers instead of calling the pool directly.
 */
export async function createMysqlPool(): Promise<Pool> {
  return db.connect({
    onReady: async (pool) => {
      await initializeDatabase(pool);
    },
  });
}

/** @deprecated Prefer `db` helpers. Kept for DDL helpers and gradual migration. */
export function getPool(): Pool {
  return db.getPool();
}

async function initializeDatabase(dbPool: Pool): Promise<void> {
  logger.info('Running database DDL initializations for prefixed tables (tbl_)...');
  const conn = await dbPool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tbl_user (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        passwordHash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NULL,
        plan VARCHAR(50) DEFAULT 'FREE',
        dailyOpsUsed INT DEFAULT 0,
        dailyOpsResetAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        monthlySignsUsed INT NOT NULL DEFAULT 0,
        monthlySignsResetAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        monthlyAiUsed INT NOT NULL DEFAULT 0,
        monthlyAiResetAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await ensureColumn(conn, 'tbl_user', 'monthlySignsUsed', 'INT NOT NULL DEFAULT 0 AFTER dailyOpsResetAt');
    await ensureColumn(conn, 'tbl_user', 'monthlySignsResetAt', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER monthlySignsUsed');
    await ensureColumn(conn, 'tbl_user', 'monthlyAiUsed', 'INT NOT NULL DEFAULT 0 AFTER monthlySignsResetAt');
    await ensureColumn(conn, 'tbl_user', 'monthlyAiResetAt', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER monthlyAiUsed');
    await ensureColumn(conn, 'tbl_user', 'emailVerified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER name');
    await ensureColumn(conn, 'tbl_user', 'emailVerifyToken', 'VARCHAR(64) NULL AFTER emailVerified');
    await ensureColumn(conn, 'tbl_user', 'emailVerifyExpiresAt', 'DATETIME(3) NULL AFTER emailVerifyToken');
    await ensureColumn(conn, 'tbl_user', 'authProvider', "VARCHAR(20) NOT NULL DEFAULT 'password' AFTER emailVerifyExpiresAt");
    await ensureIndex(conn, 'tbl_user', 'idx_user_email_verify_token', 'emailVerifyToken');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tbl_job (
        id VARCHAR(255) PRIMARY KEY,
        userId VARCHAR(255) NULL,
        tool VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'QUEUED',
        inputFiles JSON NOT NULL,
        outputFile VARCHAR(255) NULL,
        errorMessage TEXT NULL,
        createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        completedAt DATETIME(3) NULL,
        expiresAt DATETIME(3) NOT NULL,
        INDEX idx_job_user (userId),
        FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tbl_subscription (
        id VARCHAR(255) PRIMARY KEY,
        userId VARCHAR(255) UNIQUE NOT NULL,
        razorpaySubId VARCHAR(255) NULL,
        status VARCHAR(100) NOT NULL,
        currentPeriodEnd DATETIME(3) NULL,
        FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tbl_cloud_integration (
        id VARCHAR(255) PRIMARY KEY,
        userId VARCHAR(255) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        accountEmail VARCHAR(255) NOT NULL,
        accessToken TEXT NOT NULL,
        refreshToken TEXT NULL,
        autoSync TINYINT(1) DEFAULT 1,
        lastSyncAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY idx_user_provider (userId, provider),
        FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await ensureIndex(conn, 'tbl_job', 'idx_job_expiresAt', 'expiresAt');
    await ensureIndex(conn, 'tbl_job', 'idx_job_status', 'status');
    await ensureIndex(conn, 'tbl_job', 'idx_job_user_created', 'userId, createdAt');
    await ensureIndex(conn, 'tbl_subscription', 'idx_sub_razorpay', 'razorpaySubId');
    await ensureIndex(conn, 'tbl_cloud_integration', 'idx_cloud_user', 'userId');

    await initializeSigningSchema(conn);
    await initializeByocSchema(conn);
    // Letter Studio depends on tbl_organization from BYOC schema above.
    await initializeLetterSchema(conn);
    await initializeDiagramSchema(conn);
    await seedPlatformAdmin(conn);

    logger.info('Prefixed database tables (tbl_) initialization complete.');
  } catch (err: any) {
    logger.error({ err }, 'Failed to initialize database tables with prefixes');
    throw err;
  } finally {
    conn.release();
  }
}

/** Re-export connection type for transaction callers. */
export type { PoolConnection };
