import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from './logger';

let pool: mysql.Pool | null = null;

export async function createMysqlPool(): Promise<mysql.Pool> {
  if (pool) {
    return pool;
  }

  logger.info({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, db: env.DB_NAME }, 'Worker: Initializing MySQL Connection Pool');

  pool = mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    queueLimit: 100,
    timezone: 'Z',
  });

  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    logger.info('Worker: MySQL pool connected successfully');
  } catch (error: any) {
    logger.error('Worker: Failed to connect to MySQL', {
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) {
    throw new Error('Worker: MySQL pool has not been initialized');
  }
  return pool;
}
