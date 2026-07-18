import type { PoolConnection } from 'mysql2/promise';
import { ensureColumn, ensureIndex } from './ddl';
import { logger } from './logger';

/**
 * DDL for the e-signature module (tbl_sign_*).
 *
 * IMPORTANT — retention: these tables are deliberately separate from `tbl_job`.
 * `cleanupService.cleanupExpiredJobs` sweeps `tbl_job` rows (and their S3
 * objects) once `expiresAt` passes, which is correct for throwaway tool runs
 * but would destroy signed agreements. Signing documents live under their own
 * S3 prefix (`pdf-saas-signing/`) and are only removed by an explicit owner
 * delete. A signing document must never be written to tbl_job.
 *
 * `expiresAt` on tbl_sign_document is a *business* deadline (the invitation
 * lapses and status becomes EXPIRED) — it is NOT a storage-deletion trigger.
 */
export async function initializeSigningSchema(conn: PoolConnection): Promise<void> {
  logger.info('Running DDL initializations for signing tables (tbl_sign_*)...');

  // 1. Documents — one row per agreement. `fileKey` points at the ORIGINAL
  //    uploaded PDF and is never overwritten; signed output lands in a version row.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_sign_document (
      id VARCHAR(255) PRIMARY KEY,
      ownerId VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
      flowType VARCHAR(50) NOT NULL DEFAULT 'SEQUENTIAL',
      fileKey VARCHAR(512) NOT NULL,
      fileName VARCHAR(255) NOT NULL,
      fileSize BIGINT NOT NULL DEFAULT 0,
      pageCount INT NOT NULL DEFAULT 0,
      currentVersion INT NOT NULL DEFAULT 1,
      -- SHA-256 of the ORIGINAL upload, computed before anything touches the
      -- file. This is the anchor of the tamper-evidence claim: the certificate
      -- asserts "this is the document the signers agreed to", which is only
      -- provable against a hash taken prior to any modification.
      originalHash CHAR(64) NULL,
      expiresAt DATETIME(3) NULL,
      sentAt DATETIME(3) NULL,
      completedAt DATETIME(3) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_sign_doc_owner (ownerId),
      FOREIGN KEY (ownerId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 2. Versions — immutable snapshots. v1 is the original upload; each
  //    finalization appends a new row. `sha256` is the tamper-detection hash of
  //    the exact bytes stored at `fileKey`.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_sign_document_version (
      id VARCHAR(255) PRIMARY KEY,
      documentId VARCHAR(255) NOT NULL,
      version INT NOT NULL,
      fileKey VARCHAR(512) NOT NULL,
      fileSize BIGINT NOT NULL DEFAULT 0,
      sha256 CHAR(64) NULL,
      -- S3 key of the certificate of completion generated alongside this
      -- version (audit summary: who signed, when, from where, hash proof).
      certificateKey VARCHAR(512) NULL,
      -- Digital-signature provenance. digitallySigned records that a PKCS#7
      -- signature was applied (tamper-evidence). tsaTimestamp is the time an
      -- independent RFC 3161 authority attested, and tsaTokenKey points at the
      -- stored .tsr proof. All nullable: a version may predate signing, or the
      -- TSA may have been unreachable (best-effort).
      digitallySigned TINYINT(1) NOT NULL DEFAULT 0,
      selfSignedCert TINYINT(1) NOT NULL DEFAULT 0,
      tsaTimestamp DATETIME(3) NULL,
      tsaTokenKey VARCHAR(512) NULL,
      label VARCHAR(100) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_sign_version (documentId, version),
      FOREIGN KEY (documentId) REFERENCES tbl_sign_document(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 3. Recipients — `signingToken` is the secret in the signing link. It is
  //    UNIQUE and indexed because GET /sign/:token looks up by it on every hit.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_sign_recipient (
      id VARCHAR(255) PRIMARY KEY,
      documentId VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      -- E.164. Required when authMethod is SMS_OTP or the invite goes via WhatsApp.
      phone VARCHAR(32) NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'SIGNER',
      color VARCHAR(20) NOT NULL DEFAULT '#2563eb',
      signingOrder INT NOT NULL DEFAULT 1,
      authMethod VARCHAR(50) NOT NULL DEFAULT 'NONE',
      accessCodeHash VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      signingToken CHAR(64) NULL,
      tokenExpiresAt DATETIME(3) NULL,
      -- OTP challenge state. The code is bcrypt-hashed, never stored in the
      -- clear: this table is the one an attacker with read access would target,
      -- and a plaintext OTP there defeats the whole second factor.
      otpHash VARCHAR(255) NULL,
      otpExpiresAt DATETIME(3) NULL,
      otpAttempts INT NOT NULL DEFAULT 0,
      otpVerifiedAt DATETIME(3) NULL,
      -- Denormalised from the audit trail onto the signer row. The audit log is
      -- the authoritative record, but a certificate needs "Alice signed from
      -- 203.0.113.7 on a Chrome/Windows device" without scanning the log, and
      -- these are the exact values captured at the moment of signing.
      ipAddress VARCHAR(64) NULL,
      deviceInfo VARCHAR(512) NULL,
      viewedAt DATETIME(3) NULL,
      completedAt DATETIME(3) NULL,
      declineReason TEXT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_sign_recipient_token (signingToken),
      INDEX idx_sign_recipient_doc (documentId),
      FOREIGN KEY (documentId) REFERENCES tbl_sign_document(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 4. Fields — geometry stored as page-relative fractions (see SignFieldGeometry).
  //    recipientId is nullable so a field can be placed before recipients exist,
  //    and SET NULL on delete leaves an orphaned field visible in the designer
  //    rather than silently vanishing.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_sign_field (
      id VARCHAR(255) PRIMARY KEY,
      documentId VARCHAR(255) NOT NULL,
      recipientId VARCHAR(255) NULL,
      type VARCHAR(50) NOT NULL,
      label VARCHAR(255) NOT NULL DEFAULT '',
      page INT NOT NULL DEFAULT 1,
      x DOUBLE NOT NULL,
      y DOUBLE NOT NULL,
      width DOUBLE NOT NULL,
      height DOUBLE NOT NULL,
      required TINYINT(1) NOT NULL DEFAULT 1,
      locked TINYINT(1) NOT NULL DEFAULT 0,
      config JSON NULL,
      value TEXT NULL,
      filledAt DATETIME(3) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_sign_field_doc (documentId),
      INDEX idx_sign_field_recipient (recipientId),
      FOREIGN KEY (documentId) REFERENCES tbl_sign_document(id) ON DELETE CASCADE,
      FOREIGN KEY (recipientId) REFERENCES tbl_sign_recipient(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 5. Audit log — append-only. There is deliberately no UPDATE or DELETE path
  //    in the service layer; rows survive recipient deletion (recipientId is a
  //    plain column, not an FK) so the trail can't be pruned by removing a
  //    recipient. ON DELETE CASCADE from the document is the only removal, and
  //    only when the owner deletes the document outright.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_sign_audit (
      id VARCHAR(255) PRIMARY KEY,
      documentId VARCHAR(255) NOT NULL,
      recipientId VARCHAR(255) NULL,
      actorId VARCHAR(255) NULL,
      actorEmail VARCHAR(255) NULL,
      actorName VARCHAR(255) NULL,
      action VARCHAR(64) NOT NULL,
      detail TEXT NULL,
      ipAddress VARCHAR(64) NULL,
      userAgent VARCHAR(512) NULL,
      browser VARCHAR(100) NULL,
      os VARCHAR(100) NULL,
      device VARCHAR(100) NULL,
      location VARCHAR(255) NULL,
      metadata JSON NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_sign_audit_doc (documentId),
      FOREIGN KEY (documentId) REFERENCES tbl_sign_document(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Columns added after the tables first shipped. CREATE TABLE IF NOT EXISTS
  // above is a no-op on a database where these tables already exist, so every
  // column added later must ALSO be listed here or it will never reach a
  // deployed database. Both lists must stay in sync — the CREATE defines the
  // shape for new installs, these bring existing installs up to it.
  await ensureColumn(conn, 'tbl_sign_document', 'originalHash', 'CHAR(64) NULL AFTER currentVersion');
  await ensureColumn(conn, 'tbl_sign_document_version', 'certificateKey', 'VARCHAR(512) NULL AFTER sha256');
  await ensureColumn(conn, 'tbl_sign_document_version', 'digitallySigned', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER certificateKey');
  await ensureColumn(conn, 'tbl_sign_document_version', 'selfSignedCert', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER digitallySigned');
  await ensureColumn(conn, 'tbl_sign_document_version', 'tsaTimestamp', 'DATETIME(3) NULL AFTER selfSignedCert');
  await ensureColumn(conn, 'tbl_sign_document_version', 'tsaTokenKey', 'VARCHAR(512) NULL AFTER tsaTimestamp');
  await ensureColumn(conn, 'tbl_sign_recipient', 'phone', 'VARCHAR(32) NULL AFTER email');
  await ensureColumn(conn, 'tbl_sign_recipient', 'otpHash', 'VARCHAR(255) NULL AFTER tokenExpiresAt');
  await ensureColumn(conn, 'tbl_sign_recipient', 'otpExpiresAt', 'DATETIME(3) NULL AFTER otpHash');
  await ensureColumn(conn, 'tbl_sign_recipient', 'otpAttempts', 'INT NOT NULL DEFAULT 0 AFTER otpExpiresAt');
  await ensureColumn(conn, 'tbl_sign_recipient', 'otpVerifiedAt', 'DATETIME(3) NULL AFTER otpAttempts');
  await ensureColumn(conn, 'tbl_sign_recipient', 'ipAddress', 'VARCHAR(64) NULL AFTER otpVerifiedAt');
  await ensureColumn(conn, 'tbl_sign_recipient', 'deviceInfo', 'VARCHAR(512) NULL AFTER ipAddress');

  // Query-path indexes (idempotent — safe on existing databases too).
  await ensureIndex(conn, 'tbl_sign_document', 'idx_sign_doc_owner_status', 'ownerId, status');
  await ensureIndex(conn, 'tbl_sign_document', 'idx_sign_doc_owner_created', 'ownerId, createdAt');
  await ensureIndex(conn, 'tbl_sign_document', 'idx_sign_doc_status_expires', 'status, expiresAt');
  await ensureIndex(conn, 'tbl_sign_recipient', 'idx_sign_recipient_order', 'documentId, signingOrder');
  await ensureIndex(conn, 'tbl_sign_field', 'idx_sign_field_doc_page', 'documentId, page');
  await ensureIndex(conn, 'tbl_sign_audit', 'idx_sign_audit_doc_created', 'documentId, createdAt');

  logger.info('Signing tables (tbl_sign_*) initialization complete.');
}
