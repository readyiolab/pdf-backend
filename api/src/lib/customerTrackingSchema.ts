import type { PoolConnection } from 'mysql2/promise';
import { ensureIndex } from './ddl';

export async function initializeCustomerTrackingSchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_marketing_visit (
      id VARCHAR(255) PRIMARY KEY,
      visitorId VARCHAR(64) NOT NULL,
      userId VARCHAR(255) NULL,
      landingPath VARCHAR(512) NULL,
      referrer VARCHAR(1024) NULL,
      utmSource VARCHAR(255) NULL,
      utmMedium VARCHAR(255) NULL,
      utmCampaign VARCHAR(255) NULL,
      utmTerm VARCHAR(255) NULL,
      utmContent VARCHAR(255) NULL,
      gclid VARCHAR(255) NULL,
      fbclid VARCHAR(255) NULL,
      msclkid VARCHAR(255) NULL,
      ipHash VARCHAR(64) NULL,
      userAgent VARCHAR(512) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_mkt_visit_visitor (visitorId, createdAt),
      INDEX idx_mkt_visit_user (userId, createdAt),
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_user_attribution (
      userId VARCHAR(255) PRIMARY KEY,
      visitorId VARCHAR(64) NULL,
      acquisitionChannel VARCHAR(32) NOT NULL DEFAULT 'unknown',
      firstUtmSource VARCHAR(255) NULL,
      firstUtmMedium VARCHAR(255) NULL,
      firstUtmCampaign VARCHAR(255) NULL,
      firstUtmTerm VARCHAR(255) NULL,
      firstUtmContent VARCHAR(255) NULL,
      firstGclid VARCHAR(255) NULL,
      firstFbclid VARCHAR(255) NULL,
      firstMsclkid VARCHAR(255) NULL,
      firstReferrer VARCHAR(1024) NULL,
      firstLandingPath VARCHAR(512) NULL,
      lastUtmSource VARCHAR(255) NULL,
      lastUtmMedium VARCHAR(255) NULL,
      lastUtmCampaign VARCHAR(255) NULL,
      lastUtmTerm VARCHAR(255) NULL,
      lastUtmContent VARCHAR(255) NULL,
      lastGclid VARCHAR(255) NULL,
      lastFbclid VARCHAR(255) NULL,
      lastMsclkid VARCHAR(255) NULL,
      lastReferrer VARCHAR(1024) NULL,
      lastLandingPath VARCHAR(512) NULL,
      firstVisitAt DATETIME(3) NULL,
      signupAt DATETIME(3) NULL,
      lastSeenAt DATETIME(3) NULL,
      lastLoginAt DATETIME(3) NULL,
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_user_profile (
      userId VARCHAR(255) PRIMARY KEY,
      phone VARCHAR(64) NULL,
      company VARCHAR(255) NULL,
      addressLine1 VARCHAR(255) NULL,
      addressLine2 VARCHAR(255) NULL,
      city VARCHAR(128) NULL,
      state VARCHAR(128) NULL,
      postalCode VARCHAR(32) NULL,
      country VARCHAR(64) NULL,
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_contact (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NULL,
      userId VARCHAR(255) NULL,
      firstSeenAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      lastSeenAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      isRepeat TINYINT(1) NOT NULL DEFAULT 0,
      source VARCHAR(32) NULL,
      UNIQUE KEY uq_contact_email (email),
      INDEX idx_contact_user (userId),
      INDEX idx_contact_repeat (isRepeat, lastSeenAt),
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_customer_event (
      id VARCHAR(255) PRIMARY KEY,
      userId VARCHAR(255) NULL,
      contactId VARCHAR(255) NULL,
      visitorId VARCHAR(64) NULL,
      type VARCHAR(64) NOT NULL,
      metaJson JSON NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_ce_user_created (userId, createdAt),
      INDEX idx_ce_contact_created (contactId, createdAt),
      INDEX idx_ce_type_created (type, createdAt),
      INDEX idx_ce_visitor (visitorId),
      FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE SET NULL,
      FOREIGN KEY (contactId) REFERENCES tbl_contact(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await ensureIndex(conn, 'tbl_user_attribution', 'idx_attr_channel', 'acquisitionChannel');
  await ensureIndex(conn, 'tbl_user_attribution', 'idx_attr_last_seen', 'lastSeenAt');

  // One-shot backfill: existing accounts without attribution get direct/unknown rows.
  // Guests are authProvider='guest' (no isGuest column on tbl_user).
  await conn.query(`
    INSERT IGNORE INTO tbl_user_attribution (
      userId, acquisitionChannel, firstVisitAt, signupAt, lastSeenAt
    )
    SELECT u.id, 'direct', u.createdAt, u.createdAt, u.createdAt
      FROM tbl_user u
      LEFT JOIN tbl_user_attribution a ON a.userId = u.id
     WHERE COALESCE(u.authProvider, 'password') <> 'guest'
       AND a.userId IS NULL
  `);
}
