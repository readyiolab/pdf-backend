import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from './logger';

const RETRYABLE_DB_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'ECONNRESET',
  'ETIMEDOUT',
]);

async function withRetry<T>(
  operation: () => Promise<T>,
  context: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string })?.code;
      const msg = ((err as Error)?.message || '').toLowerCase();
      const retryable = (code && RETRYABLE_DB_ERRORS.has(code)) || msg.includes('deadlock');
      if (attempt >= 3 || !retryable) throw err;
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

export class Database {
  pool: Pool | null = null;
  isConnected = false;

  async connect(): Promise<Pool> {
    if (this.pool) return this.pool;

    logger.info(
      { host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, db: env.DB_NAME },
      'Worker: Initializing MySQL connection pool'
    );

    this.pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: env.DB_CONNECTION_LIMIT,
      queueLimit: 200,
      timezone: 'Z',
      multipleStatements: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });

    const connection = await this.pool.getConnection();
    await connection.ping();
    connection.release();
    this.isConnected = true;
    logger.info('Worker: MySQL connection pool ready');
    return this.pool;
  }

  getPool(): Pool {
    if (!this.pool) throw new Error('Worker: MySQL pool has not been initialized');
    return this.pool;
  }

  async queryAll<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: any[] = []
  ): Promise<T[]> {
    return withRetry(async () => {
      const [results] = await this.getPool().query<T[]>(sql, params);
      return results;
    }, 'QUERY_ALL');
  }

  async execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
    return withRetry(async () => {
      const [result] = await this.getPool().execute<ResultSetHeader>(sql, params);
      return result;
    }, 'EXECUTE');
  }

  async insert(tbl_name: string, data: Record<string, any>): Promise<ResultSetHeader> {
    const fields = Object.keys(data)
      .map((k) => `\`${k}\``)
      .join(',');
    const placeholders = Object.keys(data)
      .map(() => '?')
      .join(',');
    return this.execute(
      `INSERT INTO ${tbl_name} (${fields}) VALUES (${placeholders})`,
      Object.values(data)
    );
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
    this.isConnected = false;
  }
}

export const db = new Database();

export async function createMysqlPool(): Promise<Pool> {
  return db.connect();
}

/** @deprecated Prefer `db` helpers. */
export function getPool(): Pool {
  return db.getPool();
}

export type { PoolConnection };
