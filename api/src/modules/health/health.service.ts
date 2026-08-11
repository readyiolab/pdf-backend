import { db } from '../../lib/mysql';
import { redis } from '../../lib/redis';

export const healthService = {
  /** Process is up — do not depend on Redis/MySQL (safe for LB liveness). */
  checkLive() {
    return {
      status: 'UP' as const,
      timestamp: new Date().toISOString(),
    };
  },

  /** Ready to serve traffic — requires DB + Redis. */
  async checkReady() {
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

  /** @deprecated Prefer checkReady — kept for existing /health probes. */
  async checkHealth() {
    return this.checkReady();
  },
};
