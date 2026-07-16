import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from './logger';

let pool: mysql.Pool | null = null;

export async function createMysqlPool(): Promise<mysql.Pool> {
  if (pool) {
    return pool;
  }

  logger.info({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, db: env.DB_NAME }, 'Initializing MySQL Connection Pool');

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
    logger.info('MySQL pool connected successfully');

    // Automatically initialize tables if they don't exist (with tbl_ prefix)
    await initializeDatabase(pool);
  } catch (error: any) {
    logger.error('Failed to connect to MySQL', {
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) {
    throw new Error('MySQL pool has not been initialized');
  }
  return pool;
}

async function initializeDatabase(dbPool: mysql.Pool): Promise<void> {
  logger.info('Running database DDL initializations for prefixed tables (tbl_)...');
  const conn = await dbPool.getConnection();
  try {
    // 1. User table -> tbl_user
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tbl_user (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        passwordHash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NULL,
        plan VARCHAR(50) DEFAULT 'FREE',
        dailyOpsUsed INT DEFAULT 0,
        dailyOpsResetAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Job table -> tbl_job
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

    // 3. Subscription table -> tbl_subscription
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

    // Performance indexes (idempotent — safe on existing databases too).
    await ensureIndex(conn, 'tbl_job', 'idx_job_expiresAt', 'expiresAt');
    await ensureIndex(conn, 'tbl_job', 'idx_job_status', 'status');
    await ensureIndex(conn, 'tbl_job', 'idx_job_user_created', 'userId, createdAt');
    await ensureIndex(conn, 'tbl_subscription', 'idx_sub_razorpay', 'razorpaySubId');

    logger.info('Prefixed database tables (tbl_) initialization complete.');
  } catch (err: any) {
    logger.error({ err }, 'Failed to initialize database tables with prefixes');
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Creates an index only if it doesn't already exist. MySQL has no
 * "CREATE INDEX IF NOT EXISTS", so we check information_schema first.
 */
async function ensureIndex(
  conn: mysql.PoolConnection,
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
