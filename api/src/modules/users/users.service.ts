import { getPool } from '../../lib/mysql';
import { PLAN_LIMITS } from '@shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';

export const usersService = {
  async getUserProfile(userId: string) {
    const pool = getPool();

    // 1. Fetch User details -> tbl_user
    const [users]: any = await pool.query(
      'SELECT id, email, name, plan, dailyOpsUsed, dailyOpsResetAt, createdAt FROM tbl_user WHERE id = ?',
      [userId]
    );
    const user = users[0];

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // 2. Fetch User's last 10 jobs -> tbl_job
    const [jobs]: any = await pool.query(
      'SELECT * FROM tbl_job WHERE userId = ? ORDER BY createdAt DESC LIMIT 10',
      [userId]
    );

    const limits = PLAN_LIMITS[user.plan as 'FREE' | 'PRO'];
    const remainingOps = Math.max(0, limits.maxDailyOps - user.dailyOpsUsed);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      dailyOpsUsed: user.dailyOpsUsed,
      dailyOpsLimit: limits.maxDailyOps,
      dailyOpsRemaining: remainingOps,
      dailyOpsResetAt: user.dailyOpsResetAt,
      createdAt: user.createdAt,
      jobs: jobs.map((job: any) => {
        let inputFilesArray: string[] = [];
        try {
          if (job.inputFiles) {
            inputFilesArray = typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
          }
        } catch (e) {
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
