import { db } from '../../lib/mysql';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';

/** MySQL TINYINT / Buffer / "0"|"1" → real boolean. */
function asBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.length > 0 && value[0] !== 0;
  }
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export const usersService = {
  async getUserProfile(userId: string) {
    const user = await db.select(
      'tbl_user',
      'id, email, name, plan, emailVerified, authProvider, dailyOpsUsed, dailyOpsResetAt, createdAt',
      'id = ?',
      [userId]
    );

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const jobs = await db.selectAll('tbl_job', '*', 'userId = ?', [userId], 'ORDER BY createdAt DESC LIMIT 10');

    const limits = PLAN_LIMITS[user.plan as 'FREE' | 'PRO'];
    const remainingOps = Math.max(0, limits.maxDailyOps - user.dailyOpsUsed);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      emailVerified: asBool(user.emailVerified),
      authProvider: user.authProvider || 'password',
      dailyOpsUsed: user.dailyOpsUsed,
      dailyOpsLimit: limits.maxDailyOps,
      dailyOpsRemaining: remainingOps,
      dailyOpsResetAt: user.dailyOpsResetAt,
      createdAt: user.createdAt,
      jobs: jobs.map((job: any) => {
        let inputFilesArray: string[] = [];
        try {
          if (job.inputFiles) {
            inputFilesArray =
              typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
          }
        } catch {
          // ignore
        }
        return {
          ...job,
          inputFiles: inputFilesArray,
        };
      }),
    };
  },
};
