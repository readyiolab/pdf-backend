import type { PoolConnection } from 'mysql2/promise';
import { logger } from './logger';

/**
 * Creates an index only if it doesn't already exist. MySQL has no
 * "CREATE INDEX IF NOT EXISTS", so we check information_schema first.
 *
 * Lives here rather than in mysql.ts so schema modules (e.g. signingSchema)
 * can reuse it without importing the pool module that calls them.
 */
export async function ensureIndex(
  conn: PoolConnection,
  table: string,
  indexName: string,
  columns: string
): Promise<void> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(1) AS cnt FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  if (rows[0]?.cnt > 0) return;
  await conn.query(`CREATE INDEX ${indexName} ON ${table} (${columns})`);
  logger.info({ table, indexName }, 'Created database index');
}

/**
 * Adds a column only if it doesn't already exist.
 *
 * This project has no migration framework — schema is created at boot with
 * CREATE TABLE IF NOT EXISTS. That works for a fresh database, but it silently
 * does NOTHING to a table that already exists, so a column added to the DDL
 * later never reaches a deployed database. This closes that gap: the CREATE
 * TABLE above defines the full shape for new installs, and these guarded ALTERs
 * bring already-created tables up to it.
 *
 * `definition` is interpolated, not parameterised — MySQL doesn't accept
 * placeholders in DDL. Callers must only ever pass literals from this file,
 * never anything user-supplied.
 */
export async function ensureColumn(
  conn: PoolConnection,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(1) AS cnt FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows[0]?.cnt > 0) return;
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info({ table, column }, 'Added database column');
}
