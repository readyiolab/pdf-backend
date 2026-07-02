import { getPool } from '../../lib/mysql';
import { redis } from '../../lib/redis';

export const healthService = {
  async checkHealth() {
    let dbStatus = 'UP';
    let redisStatus = 'UP';

    try {
      const pool = getPool();
      await pool.query('SELECT 1');
    } catch (err) {
      dbStatus = 'DOWN';
    }

    try {
      await redis.ping();
    } catch (err) {
      redisStatus = 'DOWN';
    }

    const overallStatus = dbStatus === 'UP' && redisStatus === 'UP' ? 'UP' : 'DEGRADED';

    return {
      status: overallStatus,
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
      timestamp: new Date().toISOString(),
    };
  },
};
