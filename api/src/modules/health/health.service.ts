import { db } from '../../lib/mysql';
import { redis } from '../../lib/redis';

export const healthService = {
  async checkHealth() {
    let dbStatus = 'UP';
    let redisStatus = 'UP';

    try {
      const check = await db.healthCheck();
      dbStatus = check.status === 'healthy' ? 'UP' : 'DOWN';
    } catch {
      dbStatus = 'DOWN';
    }

    try {
      await redis.ping();
    } catch {
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
