import { getPool } from '../../lib/mysql';
import { pushToQueue } from '../../lib/queue';
import {
  getSignedDownloadUrl,
  headObjectSize,
  readObjectHead,
  deleteObject,
} from '../../lib/s3';
import { env } from '../../config/env';
import { PLAN_LIMITS, TOOL_INPUT_TYPES } from '../../../../shared/constants';
import { detectFileCategory } from '../../../../shared/fileType';
import { AppError } from '../../middleware/errorHandler.middleware';
import { CreateJobInput } from './jobs.types';
import { ToolName } from '../../../../shared/types';
import crypto from 'crypto';

/**
 * Validates every uploaded input BEFORE any processing: enforces the real object
 * size against the plan limit (the presigned PUT can't) and verifies the true
 * file type from magic bytes (the client-declared Content-Type is untrusted).
 * Rejected objects are deleted so they don't linger in storage.
 */
async function validateInputs(
  inputFiles: string[],
  tool: ToolName,
  maxFileSize: number
): Promise<void> {
  const allowed = TOOL_INPUT_TYPES[tool];

  for (const key of inputFiles) {
    let size: number;
    try {
      size = await headObjectSize(key);
    } catch {
      throw new AppError('An uploaded file could not be found. Please re-upload.', 400);
    }

    if (size <= 0) {
      await deleteObject(key);
      throw new AppError('An uploaded file is empty.', 400);
    }
    if (size > maxFileSize) {
      await deleteObject(key);
      const maxMb = Math.floor(maxFileSize / (1024 * 1024));
      throw new AppError(`A file exceeds your plan limit of ${maxMb}MB.`, 400);
    }

    const head = await readObjectHead(key, 1024);
    const category = detectFileCategory(head);
    if (!allowed.includes(category)) {
      await deleteObject(key);
      throw new AppError(
        `An uploaded file is not a valid input for this tool.`,
        400
      );
    }
  }
}

export const jobsService = {
  async createJob(userId: string, input: CreateJobInput) {
    const { tool, inputFiles, options } = input;
    const pool = getPool();

    // 1. Fetch the authenticated user. authMiddleware guarantees the user exists,
    //    so a miss here is a real error — never auto-create accounts.
    const [users]: any = await pool.query(
      'SELECT id, plan FROM tbl_user WHERE id = ?',
      [userId]
    );
    const user = users[0];
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const limits = PLAN_LIMITS[user.plan as 'FREE' | 'PRO'];
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 2. Validate inputs (real size + magic bytes) BEFORE charging quota or
    //    enqueuing, so a rejected upload never consumes an operation.
    await validateInputs(inputFiles, tool as ToolName, limits.maxFileSize);

    // 3. Atomically reserve one daily operation. A single guarded UPDATE avoids
    //    the read-modify-write race where concurrent requests both pass the check.
    //    - If the 24h window has elapsed, the counter resets to 1 and the window rolls.
    //    - Otherwise it increments only while still under the plan limit.
    //    (dailyOpsUsed is assigned first so it reads the ORIGINAL dailyOpsResetAt.)
    const [reserve]: any = await pool.query(
      `UPDATE tbl_user
         SET dailyOpsUsed   = IF(dailyOpsResetAt < ?, 1, dailyOpsUsed + 1),
             dailyOpsResetAt = IF(dailyOpsResetAt < ?, ?, dailyOpsResetAt)
       WHERE id = ?
         AND (dailyOpsResetAt < ? OR dailyOpsUsed < ?)`,
      [windowCutoff, windowCutoff, now, user.id, windowCutoff, limits.maxDailyOps]
    );

    if (reserve.affectedRows === 0) {
      throw new AppError(
        `Daily operations limit of ${limits.maxDailyOps} reached for your ${user.plan} plan. Please upgrade to PRO.`,
        403
      );
    }

    // 4. Create the Job record in DB -> tbl_job
    const jobId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + env.JOB_TTL_MINUTES * 60 * 1000);
    const inputFilesStr = JSON.stringify(inputFiles);

    try {
      await pool.query(
        'INSERT INTO tbl_job (id, userId, tool, status, inputFiles, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
        [jobId, user.id, tool, 'QUEUED', inputFilesStr, expiresAt]
      );

      // 5. Push to BullMQ queue (PRO users get higher priority)
      await pushToQueue(jobId, user.id, tool as ToolName, inputFiles, options, user.plan);
    } catch (err) {
      // Compensate the reserved operation if we failed to enqueue the job so the
      // user is not charged for work that never ran.
      await pool
        .query(
          'UPDATE tbl_user SET dailyOpsUsed = GREATEST(dailyOpsUsed - 1, 0) WHERE id = ?',
          [user.id]
        )
        .catch(() => undefined);
      throw err;
    }

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

  /**
   * Returns a short-lived signed download URL for a completed job's output,
   * but only to the job's owner. Result objects are private, so this is the
   * only way to retrieve them.
   */
  async getDownloadUrl(jobId: string, userId: string): Promise<{ url: string }> {
    const pool = getPool();
    const [jobs]: any = await pool.query(
      'SELECT userId, status, outputFile FROM tbl_job WHERE id = ?',
      [jobId]
    );
    const job = jobs[0];

    if (!job) {
      throw new AppError('Job not found', 404);
    }
    if (job.userId !== userId) {
      throw new AppError('Unauthorized access to job', 403);
    }
    if (job.status !== 'COMPLETED' || !job.outputFile) {
      throw new AppError('Result is not ready for download', 409);
    }

    const fileName = job.outputFile.split('/').pop() || 'download.pdf';
    const url = await getSignedDownloadUrl(job.outputFile, fileName);
    return { url };
  },
};
