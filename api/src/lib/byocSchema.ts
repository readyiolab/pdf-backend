import crypto from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { logger } from './logger';
import { ensureColumn, ensureIndex } from './ddl';

/**
 * Enterprise BYOC tables. Members / multi-admin RBAC are intentionally deferred —
 * an org has a single ownerUserId for v1.
 *
 * Storage bindings are append-only so provider switches do not orphan objects.
 * tbl_org_storage_config holds the active pointer + health; credentials live on
 * tbl_org_storage_binding rows.
 */
export async function initializeByocSchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_organization (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      plan VARCHAR(50) NOT NULL DEFAULT 'ENTERPRISE',
      licenseKey VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      ownerUserId VARCHAR(255) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_org_slug (slug),
      UNIQUE KEY uq_org_owner (ownerUserId),
      FOREIGN KEY (ownerUserId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_org_storage_config (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'PLATFORM',
      bucket VARCHAR(255) NULL,
      region VARCHAR(100) NULL,
      endpoint VARCHAR(512) NULL,
      encryptedCredentials TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'UNCONFIGURED',
      lastTestedAt DATETIME(3) NULL,
      lastError TEXT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_org_storage (organizationId),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_org_storage_binding (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      provider VARCHAR(50) NOT NULL,
      bucket VARCHAR(255) NULL,
      region VARCHAR(100) NULL,
      endpoint VARCHAR(512) NULL,
      encryptedCredentials TEXT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      retiredAt DATETIME(3) NULL,
      INDEX idx_org_binding_org (organizationId),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_org_infra_audit (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      actorId VARCHAR(255) NULL,
      action VARCHAR(100) NOT NULL,
      detail TEXT NULL,
      ipAddress VARCHAR(64) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_org_audit_org_created (organizationId, createdAt),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Health + active binding pointer on the mutable config row
  await ensureColumn(
    conn,
    'tbl_org_storage_config',
    'activeBindingId',
    'VARCHAR(255) NULL AFTER organizationId'
  );
  await ensureColumn(
    conn,
    'tbl_org_storage_config',
    'lastHealthyAt',
    'DATETIME(3) NULL AFTER lastTestedAt'
  );
  await ensureColumn(
    conn,
    'tbl_org_storage_config',
    'consecutiveFailures',
    'INT NOT NULL DEFAULT 0 AFTER lastError'
  );
  await ensureColumn(
    conn,
    'tbl_org_storage_config',
    'corsVerifiedAt',
    'DATETIME(3) NULL AFTER consecutiveFailures'
  );

  await ensureColumn(conn, 'tbl_user', 'organizationId', 'VARCHAR(255) NULL AFTER plan');
  await ensureColumn(conn, 'tbl_user', 'isPlatformAdmin', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER authProvider');
  await ensureColumn(conn, 'tbl_job', 'organizationId', 'VARCHAR(255) NULL AFTER userId');
  await ensureColumn(conn, 'tbl_job', 'storageBindingId', 'VARCHAR(255) NULL AFTER organizationId');

  // Signing tables may already exist via signingSchema — add binding columns when present
  await ensureColumnIfTableExists(
    conn,
    'tbl_sign_document',
    'storageBindingId',
    'VARCHAR(255) NULL AFTER fileKey'
  );
  await ensureColumnIfTableExists(
    conn,
    'tbl_sign_document_version',
    'storageBindingId',
    'VARCHAR(255) NULL AFTER fileKey'
  );
  await ensureColumnIfTableExists(
    conn,
    'tbl_sign_template',
    'storageBindingId',
    'VARCHAR(255) NULL AFTER fileKey'
  );

  await ensureIndex(conn, 'tbl_user', 'idx_user_organization', 'organizationId');
  await ensureIndex(conn, 'tbl_job', 'idx_job_organization', 'organizationId');
  await ensureIndex(conn, 'tbl_job', 'idx_job_storage_binding', 'storageBindingId');

  await backfillStorageBindings(conn);

  logger.info('BYOC / organization schema ready');
}

async function ensureColumnIfTableExists(
  conn: PoolConnection,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(1) AS cnt FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  if (!rows[0]?.cnt) return;
  await ensureColumn(conn, table, column, definition);
}

/**
 * One-time migration: for each non-PLATFORM config without an activeBindingId,
 * create a binding row from the legacy columns and point activeBindingId at it.
 * Then stamp storageBindingId on rows whose keys start with org-{id}/.
 */
async function backfillStorageBindings(conn: PoolConnection): Promise<void> {
  const [configs]: any = await conn.query(
    `SELECT * FROM tbl_org_storage_config
      WHERE (activeBindingId IS NULL OR activeBindingId = '')
        AND provider IS NOT NULL AND provider <> 'PLATFORM'
        AND encryptedCredentials IS NOT NULL AND encryptedCredentials <> ''`
  );

  for (const cfg of configs as any[]) {
    const bindingId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO tbl_org_storage_binding
        (id, organizationId, provider, bucket, region, endpoint, encryptedCredentials, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP(3)))`,
      [
        bindingId,
        cfg.organizationId,
        cfg.provider,
        cfg.bucket,
        cfg.region,
        cfg.endpoint,
        cfg.encryptedCredentials,
        cfg.createdAt ?? null,
      ]
    );
    await conn.query(
      `UPDATE tbl_org_storage_config SET activeBindingId = ? WHERE id = ?`,
      [bindingId, cfg.id]
    );

    // Stamp jobs / signing rows that live under this org prefix
    const prefix = `org-${cfg.organizationId}/%`;
    await conn.query(
      `UPDATE tbl_job SET storageBindingId = ?
        WHERE organizationId = ? AND (storageBindingId IS NULL OR storageBindingId = '')
          AND (
            outputFile LIKE ?
            OR CAST(inputFiles AS CHAR) LIKE ?
          )`,
      [bindingId, cfg.organizationId, prefix, `%${prefix.slice(0, -1)}%`]
    );

    const [signDocExists]: any = await conn.query(
      `SELECT COUNT(1) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'tbl_sign_document'`
    );
    if (signDocExists[0]?.cnt) {
      await conn.query(
        `UPDATE tbl_sign_document SET storageBindingId = ?
          WHERE storageBindingId IS NULL AND fileKey LIKE ?`,
        [bindingId, prefix]
      );
      await conn.query(
        `UPDATE tbl_sign_document_version SET storageBindingId = ?
          WHERE storageBindingId IS NULL AND fileKey LIKE ?`,
        [bindingId, prefix]
      );
    }

    const [tplExists]: any = await conn.query(
      `SELECT COUNT(1) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'tbl_sign_template'`
    );
    if (tplExists[0]?.cnt) {
      await conn.query(
        `UPDATE tbl_sign_template SET storageBindingId = ?
          WHERE storageBindingId IS NULL AND fileKey LIKE ?`,
        [bindingId, prefix]
      );
    }

    logger.info(
      { organizationId: cfg.organizationId, bindingId },
      'Backfilled BYOC storage binding from legacy config'
    );
  }
}
