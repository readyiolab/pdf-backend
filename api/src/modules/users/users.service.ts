import { db } from '../../lib/mysql';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';

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
      emailVerified: Boolean(user.emailVerified),
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
