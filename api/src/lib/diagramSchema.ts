import type { PoolConnection } from 'mysql2/promise';
import { ensureIndex } from './ddl';

export async function initializeDiagramSchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_diagram_folder (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      createdBy VARCHAR(255) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_diagram (
      id VARCHAR(255) PRIMARY KEY,
      organizationId VARCHAR(255) NOT NULL,
      folderId VARCHAR(255) NULL,
      title VARCHAR(255) NOT NULL DEFAULT 'Untitled Diagram',
      contentJson LONGTEXT NOT NULL,
      thumbnailPngKey VARCHAR(512) NULL,
      currentVersion INT NOT NULL DEFAULT 1,
      createdBy VARCHAR(255) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      FOREIGN KEY (organizationId) REFERENCES tbl_organization(id) ON DELETE CASCADE,
      FOREIGN KEY (folderId) REFERENCES tbl_diagram_folder(id) ON DELETE SET NULL,
      FOREIGN KEY (createdBy) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_diagram_version (
      id VARCHAR(255) PRIMARY KEY,
      diagramId VARCHAR(255) NOT NULL,
      version INT NOT NULL,
      contentJson LONGTEXT NOT NULL,
      createdBy VARCHAR(255) NOT NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY (diagramId) REFERENCES tbl_diagram(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES tbl_user(id) ON DELETE CASCADE,
      UNIQUE KEY uq_diagram_version (diagramId, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_diagram_share (
      id VARCHAR(255) PRIMARY KEY,
      diagramId VARCHAR(255) NOT NULL,
      token VARCHAR(64) NOT NULL,
      role ENUM('VIEW','EDIT') NOT NULL DEFAULT 'VIEW',
      createdBy VARCHAR(255) NOT NULL,
      expiresAt DATETIME(3) NULL,
      revokedAt DATETIME(3) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY (diagramId) REFERENCES tbl_diagram(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES tbl_user(id) ON DELETE CASCADE,
      UNIQUE KEY uq_diagram_share_token (token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await ensureIndex(conn, 'tbl_diagram', 'idx_diagram_org_updated', 'organizationId, updatedAt');
  await ensureIndex(conn, 'tbl_diagram', 'idx_diagram_folder', 'folderId');
  await ensureIndex(conn, 'tbl_diagram_folder', 'idx_diagram_folder_org', 'organizationId');
  await ensureIndex(conn, 'tbl_diagram_version', 'idx_diagram_version_diagram', 'diagramId, version');
  await ensureIndex(conn, 'tbl_diagram_share', 'idx_diagram_share_diagram', 'diagramId');
}
