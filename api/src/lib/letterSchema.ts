import crypto from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { logger } from './logger';
import { ensureColumn, ensureIndex } from './ddl';

/**
 * Employee Letter Studio schema + org membership/RBAC foundation.
 *
 * Extends the existing tbl_organization (BYOC) with multi-member roles via
 * tbl_org_user / tbl_org_invite. Letter-specific tables use the tbl_letter_*
 * prefix. Naming follows the rest of the codebase: camelCase columns,
 * createdAt/updatedAt DATETIME(3).
 */
export async function initializeLetterSchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_org_user (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      userId VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'VIEWER',
      invitedBy VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_org_user (organizationId, userId),
      INDEX idx_org_user_user (userId),
      INDEX idx_org_user_org_status (organizationId, status),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_org_invite (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'VIEWER',
      token VARCHAR(64) NOT NULL,
      invitedBy VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      expiresAt DATETIME(3) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_org_invite_token (token),
      INDEX idx_org_invite_org_email (organizationId, email),
      INDEX idx_org_invite_status (status),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_brand_profile (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      logoKey VARCHAR(512) NULL,
      letterheadKey VARCHAR(512) NULL,
      footerText TEXT NULL,
      signatoryName VARCHAR(255) NULL,
      signatoryDesignation VARCHAR(255) NULL,
      defaultFont VARCHAR(100) NOT NULL DEFAULT 'Inter',
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_letter_brand_org (organizationId),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_template (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(100) NOT NULL,
      contentJson JSON NOT NULL,
      fieldTokens JSON NOT NULL,
      version INT NOT NULL DEFAULT 1,
      createdBy VARCHAR(255) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_letter_template_org (organizationId),
      INDEX idx_letter_template_type (organizationId, type),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_batch (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      templateId VARCHAR(255) NULL,
      brandProfileId VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
      totalRows INT NOT NULL DEFAULT 0,
      readyCount INT NOT NULL DEFAULT 0,
      warningCount INT NOT NULL DEFAULT 0,
      blockedCount INT NOT NULL DEFAULT 0,
      generatedCount INT NOT NULL DEFAULT 0,
      failedCount INT NOT NULL DEFAULT 0,
      sentCount INT NOT NULL DEFAULT 0,
      columnMappingJson JSON NULL,
      sourceFileKey VARCHAR(512) NULL,
      sourceFileName VARCHAR(255) NULL,
      passwordMode VARCHAR(50) NOT NULL DEFAULT 'NONE',
      sendMode VARCHAR(50) NOT NULL DEFAULT 'GENERATE_ONLY',
      aiSummary TEXT NULL,
      retentionDays INT NULL,
      createdBy VARCHAR(255) NULL,
      approvedAt DATETIME(3) NULL,
      generatedAt DATETIME(3) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_letter_batch_org (organizationId),
      INDEX idx_letter_batch_status (organizationId, status),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_batch_employee (
      id VARCHAR(255) PRIMARY KEY,
      batchId VARCHAR(255) NOT NULL,
      rowIndex INT NOT NULL DEFAULT 0,
      employeeDataJson JSON NOT NULL,
      validationStatus VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      validationErrorsJson JSON NULL,
      anomalyFlagsJson JSON NULL,
      pdfKey VARCHAR(512) NULL,
      pdfFileName VARCHAR(255) NULL,
      encryptedPdfPassword TEXT NULL,
      sendStatus VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_letter_emp_batch (batchId),
      INDEX idx_letter_emp_validation (batchId, validationStatus),
      INDEX idx_letter_emp_send (batchId, sendStatus),
      FOREIGN KEY (batchId) REFERENCES tbl_letter_batch(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_send_log (
      id VARCHAR(255) PRIMARY KEY,
      batchEmployeeId VARCHAR(255) NOT NULL,
      channel VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      errorMessage TEXT NULL,
      sentAt DATETIME(3) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_letter_send_emp (batchEmployeeId),
      FOREIGN KEY (batchEmployeeId) REFERENCES tbl_letter_batch_employee(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_audit (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      userId VARCHAR(255) NULL,
      action VARCHAR(100) NOT NULL,
      entityType VARCHAR(100) NOT NULL,
      entityId VARCHAR(255) NULL,
      metadataJson JSON NULL,
      aiAssisted TINYINT(1) NOT NULL DEFAULT 0,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_letter_audit_org_created (organizationId, createdAt),
      INDEX idx_letter_audit_entity (entityType, entityId),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_user_mail_account (
      id VARCHAR(255) PRIMARY KEY,
      userId VARCHAR(255) NOT NULL,
      provider VARCHAR(50) NOT NULL,
      emailAddress VARCHAR(255) NOT NULL,
      encryptedTokens TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'CONNECTED',
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_user_mail_provider (userId, provider),
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_letter_embedding (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      sourceType VARCHAR(50) NOT NULL,
      sourceId VARCHAR(255) NOT NULL,
      chunkText TEXT NOT NULL,
      vectorJson JSON NOT NULL,
      model VARCHAR(100) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_letter_emb_org_source (organizationId, sourceType, sourceId),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Org-level letter settings (retention etc.) hang off tbl_organization
  await ensureColumn(
    conn,
    'tbl_organization',
    'letterRetentionDays',
    'INT NOT NULL DEFAULT 30 AFTER status'
  );

  await ensureIndex(conn, 'tbl_org_user', 'idx_org_user_user', 'userId');
  await ensureIndex(conn, 'tbl_org_user', 'idx_org_user_user_status', 'userId, status');
  await ensureIndex(conn, 'tbl_letter_batch', 'idx_letter_batch_created', 'organizationId, createdAt');
  await ensureIndex(
    conn,
    'tbl_letter_batch',
    'idx_letter_batch_org_created',
    'organizationId, createdAt'
  );

  await seedOwnerMemberships(conn);

  logger.info('Letter Studio / org membership schema ready');
}

/**
 * Idempotent: for every existing organization, ensure the ownerUserId has an
 * OWNER membership row in tbl_org_user.
 */
async function seedOwnerMemberships(conn: PoolConnection): Promise<void> {
  const [orgs]: any = await conn.query(
    `SELECT id, ownerUserId FROM tbl_organization WHERE ownerUserId IS NOT NULL`
  );

  let inserted = 0;
  for (const org of orgs as Array<{ id: string; ownerUserId: string }>) {
    const [existing]: any = await conn.query(
      `SELECT id FROM tbl_org_user WHERE organizationId = ? AND userId = ? LIMIT 1`,
      [org.id, org.ownerUserId]
    );
    if (existing.length > 0) continue;

    await conn.query(
      `INSERT INTO tbl_org_user (id, organizationId, userId, role, invitedBy, status)
       VALUES (?, ?, ?, 'OWNER', ?, 'ACTIVE')`,
      [crypto.randomUUID(), org.id, org.ownerUserId, org.ownerUserId]
    );
    inserted += 1;
  }

  if (inserted > 0) {
    logger.info({ inserted }, 'Seeded OWNER memberships for existing organizations');
  }
}
