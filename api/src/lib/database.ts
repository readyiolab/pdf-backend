import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from './logger';
import { withRetry } from './retry';
import { normalizeOrderBy } from './databaseOrderBy';

/** MySQL / network errors worth retrying. */
const RETRYABLE_DB_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'ECONNRESET',
  'ETIMEDOUT',
]);

function isRetryable(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (err?.code && RETRYABLE_DB_ERRORS.has(err.code)) return true;
  return (err?.message || '').toLowerCase().includes('deadlock');
}

export interface DbWriteResult {
  status: true;
  insertId: number;
  affected_rows: number;
  info: string;
}

/**
 * Shared MySQL access layer — select / insert / update / delete / query helpers
 * with retries for transient connection and deadlock errors.
 */
export class Database {
  pool: Pool | null = null;
  isConnected = false;

  async connect(options?: {
    onReady?: (pool: Pool) => Promise<void>;
  }): Promise<Pool> {
    if (this.pool) return this.pool;

    const poolLimit = env.DB_CONNECTION_LIMIT || 25;

    logger.info(
      { host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, db: env.DB_NAME, poolLimit },
      'Initializing MySQL connection pool'
    );

    this.pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: poolLimit,
      queueLimit: 0,
      timezone: 'Z',
      multipleStatements: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });

    await this.testConnection();

    if (options?.onReady) {
      await options.onReady(this.pool);
    }

    return this.pool;
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error('MySQL pool has not been initialized — call createMysqlPool() / db.connect() first');
    }
    return this.pool;
  }

  private async _executeWithRetry<T>(operation: () => Promise<T>, context = 'DB'): Promise<T> {
    return withRetry(operation, {
      maxAttempts: 3,
      baseDelay: 500,
      maxDelay: 5000,
      context,
      retryIf: isRetryable,
    });
  }

  async testConnection(): Promise<void> {
    try {
      const connection = await this.getPool().getConnection();
      await connection.ping();
      connection.release();
      this.isConnected = true;
      logger.info('MySQL connection pool ready');
    } catch (err) {
      this.isConnected = false;
      logger.error({ err }, 'Database pool error');
      throw err;
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; poolSize?: number; error?: string }> {
    try {
      const connection = await this.getPool().getConnection();
      await connection.ping();
      connection.release();
      const poolSize = (this.pool as any)?.pool?._allConnections?.length ?? 0;
      return { status: 'healthy', poolSize };
    } catch (err) {
      return {
        status: 'unhealthy',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** First matching row, or undefined. */
  async select<T extends RowDataPacket = RowDataPacket>(
    tbl_name: string,
    column = '*',
    where = '',
    params: any[] = [],
    print = false
  ): Promise<T | undefined> {
    const wr = where ? `WHERE ${where}` : '';
    const sql = `SELECT ${column} FROM ${tbl_name} ${wr}`;
    if (print) logger.debug({ sql, params }, 'SQL SELECT');
    return this._executeWithRetry(async () => {
      const [results] = await this.getPool().execute<T[]>(sql, params);
      return results[0];
    }, 'SELECT');
  }

  /** All matching rows. */
  async selectAll<T extends RowDataPacket = RowDataPacket>(
    tbl_name: string,
    column = '*',
    where = '',
    params: any[] = [],
    orderby = '',
    print = false
  ): Promise<T[]> {
    const wr = where ? `WHERE ${where}` : '';
    const ob = normalizeOrderBy(orderby);
    const sql = `SELECT ${column} FROM ${tbl_name} ${wr} ${ob}`.trim();
    if (print) logger.debug({ sql, params }, 'SQL SELECT_ALL');
    return this._executeWithRetry(async () => {
      const [results] = await this.getPool().execute<T[]>(sql, params);
      return results;
    }, 'SELECT_ALL');
  }

  async insert(tbl_name: string, data: Record<string, unknown>, print = false): Promise<DbWriteResult> {
    const fields = Object.keys(data)
      .map((key) => `\`${key}\``)
      .join(',');
    const placeholders = Object.keys(data)
      .map(() => '?')
      .join(',');
    const values = Object.values(data) as any[];

    const sql = `INSERT INTO ${tbl_name} (${fields}) VALUES (${placeholders})`;
    if (print) logger.debug({ sql, values }, 'SQL INSERT');
    return this._executeWithRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, values);
      return {
        status: true as const,
        insertId: result.insertId,
        affected_rows: result.affectedRows,
        info: result.info,
      };
    }, 'INSERT');
  }

  async upsert(
    tbl_name: string,
    data: Record<string, unknown>,
    updateData: Record<string, unknown> | null = null,
    print = false
  ): Promise<DbWriteResult> {
    const fields = Object.keys(data)
      .map((key) => `\`${key}\``)
      .join(',');
    const placeholders = Object.keys(data)
      .map(() => '?')
      .join(',');
    const values = Object.values(data) as any[];

    const dataToUpdate = updateData || data;
    const updates = Object.entries(dataToUpdate)
      .filter(([key]) => key !== 'id' && key !== 'user_id' && key !== 'userId')
      .map(([key]) => `\`${key}\` = VALUES(\`${key}\`)`);

    const sql = `INSERT INTO ${tbl_name} (${fields}) VALUES (${placeholders})
                 ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;
    if (print) logger.debug({ sql, values }, 'SQL UPSERT');
    return this._executeWithRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, values);
      return {
        status: true as const,
        insertId: result.insertId,
        affected_rows: result.affectedRows,
        info: result.info,
      };
    }, 'UPSERT');
  }

  async update(
    table_name: string,
    form_data: Record<string, unknown>,
    where = '',
    params: any[] = [],
    print = false
  ): Promise<DbWriteResult> {
    const whereSQL = where ? ` WHERE ${where}` : '';
    const sets = Object.entries(form_data).map(([column]) => `\`${column}\` = ?`);
    const values = Object.values(form_data);
    const queryParams = [...values, ...params] as any[];

    const sql = `UPDATE ${table_name} SET ${sets.join(', ')}${whereSQL}`;
    if (print) logger.debug({ sql, queryParams }, 'SQL UPDATE');
    return this._executeWithRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, queryParams);
      return {
        status: true as const,
        insertId: result.insertId,
        affected_rows: result.affectedRows,
        info: result.info,
      };
    }, 'UPDATE');
  }

  async delete(
    tbl_name: string,
    where = '',
    params: any[] = [],
    print = false
  ): Promise<DbWriteResult> {
    const whereSQL = where ? ` WHERE ${where}` : '';
    const sql = `DELETE FROM ${tbl_name}${whereSQL}`;
    if (print) logger.debug({ sql, params }, 'SQL DELETE');
    return this._executeWithRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, params);
      return {
        status: true as const,
        insertId: result.insertId,
        affected_rows: result.affectedRows,
        info: result.info,
      };
    }, 'DELETE');
  }

  /** First row of a raw query (or undefined). */
  async query<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: any[] = [],
    print = false
  ): Promise<T | undefined> {
    if (print) logger.debug({ sql, params }, 'SQL QUERY');
    return this._executeWithRetry(async () => {
      const [results] = await this.getPool().query<T[]>(sql, params);
      return results[0];
    }, 'QUERY');
  }

  /** All rows of a raw query. */
  async queryAll<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: any[] = [],
    print = false
  ): Promise<T[]> {
    if (print) logger.debug({ sql, params }, 'SQL QUERY_ALL');
    return this._executeWithRetry(async () => {
      const [results] = await this.getPool().query<T[]>(sql, params);
      return results;
    }, 'QUERY_ALL');
  }

  /** ResultSetHeader for INSERT/UPDATE/DELETE raw SQL. */
  async execute(
    sql: string,
    params: any[] = [],
    print = false
  ): Promise<ResultSetHeader> {
    if (print) logger.debug({ sql, params }, 'SQL EXECUTE');
    return this._executeWithRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, params);
      return result;
    }, 'EXECUTE');
  }

  async insertAll(sql: string, params: any[] = [], print = false): Promise<{ status: true }> {
    if (print) logger.debug({ sql, params }, 'SQL INSERT_ALL');
    return this._executeWithRetry(async () => {
      await this.getPool().execute(sql, params);
      return { status: true as const };
    }, 'INSERT_ALL');
  }

  async count(tbl_name: string, where = '', params: any[] = [], print = false): Promise<number> {
    const wr = where ? `WHERE ${where}` : '';
    const sql = `SELECT COUNT(*) as total FROM ${tbl_name} ${wr}`;
    if (print) logger.debug({ sql, params }, 'SQL COUNT');
    return this._executeWithRetry(async () => {
      const [results] = await this.getPool().execute<RowDataPacket[]>(sql, params);
      return Number(results[0]?.total ?? 0);
    }, 'COUNT');
  }

  async beginTransaction(): Promise<PoolConnection> {
    const connection = await this.getPool().getConnection();
    await connection.beginTransaction();
    return connection;
  }

  async commit(connection: PoolConnection): Promise<void> {
    await connection.commit();
    connection.release();
  }

  async rollback(connection: PoolConnection): Promise<void> {
    try {
      await connection.rollback();
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    logger.info('Closing database pool…');
    await this.pool.end();
    this.pool = null;
    this.isConnected = false;
    logger.info('Database pool closed');
  }
}

/** App-wide MySQL helper — prefer this over raw getPool().query. */
export const db = new Database();
