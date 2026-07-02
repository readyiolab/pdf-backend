import { getPool } from '../../lib/mysql';
import { pushToQueue } from '../../lib/queue';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';
import { CreateJobInput } from './jobs.types';
import { ToolName } from '../../../../shared/types';
import crypto from 'crypto';

export const jobsService = {
  async createJob(userId: string, input: CreateJobInput) {
    const { tool, inputFiles, options } = input;
    const pool = getPool();

    // 1. Fetch user (or auto-create mock user for development setup)
    const [users]: any = await pool.query('SELECT * FROM tbl_user WHERE id = ?', [userId]);
    let user = users[0];

    if (!user) {
      const mockId = userId;
      const email = 'mock@example.com';
      const passwordHash = '$2b$10$mockhashmockhashmockhashmockhashmockhashmockhash';
      const name = 'Mock User';
      const plan = 'FREE';
      
      await pool.query(
        'INSERT INTO tbl_user (id, email, passwordHash, name, plan) VALUES (?, ?, ?, ?, ?)',
        [mockId, email, passwordHash, name, plan]
      );
      
      user = { id: mockId, email, passwordHash, name, plan, dailyOpsUsed: 0, dailyOpsResetAt: new Date(), createdAt: new Date() };
    }

    // 2. Check and reset daily limits if a new day has started
    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let dailyOpsUsed = user.dailyOpsUsed;
    let dailyOpsResetAt = new Date(user.dailyOpsResetAt);

    if (now.getTime() - dailyOpsResetAt.getTime() >= oneDayMs) {
      dailyOpsUsed = 0;
      dailyOpsResetAt = now;
    }

    // 3. Check plan limits
    const limits = PLAN_LIMITS[user.plan as 'FREE' | 'PRO'];
    if (dailyOpsUsed >= limits.maxDailyOps) {
      throw new AppError(
        `Daily operations limit of ${limits.maxDailyOps} reached for your ${user.plan} plan. Please upgrade to PRO.`,
        403
      );
    }

    // 4. Create the Job record in DB -> tbl_job
    const jobId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL
    const inputFilesStr = JSON.stringify(inputFiles);

    await pool.query(
      'INSERT INTO tbl_job (id, userId, tool, status, inputFiles, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
      [jobId, user.id, tool, 'QUEUED', inputFilesStr, expiresAt]
    );

    // 5. Update user operation count -> tbl_user
    await pool.query(
      'UPDATE tbl_user SET dailyOpsUsed = ?, dailyOpsResetAt = ? WHERE id = ?',
      [dailyOpsUsed + 1, dailyOpsResetAt, user.id]
    );

    // 6. Push to BullMQ queue
    await pushToQueue(jobId, user.id, tool as ToolName, inputFiles, options);

    return {
      id: jobId,
      userId: user.id,
      tool,
      status: 'QUEUED',
      inputFiles: inputFiles,
      outputFile: null,
      errorMessage: null,
      createdAt: now,
      completedAt: null,
      expiresAt,
    };
  },

  async getJobById(jobId: string, userId: string) {
    const pool = getPool();
    const [jobs]: any = await pool.query('SELECT * FROM tbl_job WHERE id = ?', [jobId]);
    const job = jobs[0];

    if (!job) {
      throw new AppError('Job not found', 404);
    }

    // Ensure users can only poll their own jobs
    if (job.userId !== userId) {
      throw new AppError('Unauthorized access to job details', 403);
    }

    let inputFilesArray: string[] = [];
    try {
      if (job.inputFiles) {
        inputFilesArray = typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
      }
    } catch (e) {
      // fallback
    }

    return {
      ...job,
      inputFiles: inputFilesArray,
    };
  },
};
