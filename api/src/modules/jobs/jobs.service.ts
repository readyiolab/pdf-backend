import { db } from '../../lib/mysql';
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
import {
  asPlan,
  getActiveStorageBindingId,
  getOrganizationIdForUser,
  reportRuntimeStorageFailure,
} from '../../lib/storage';
import crypto from 'crypto';

async function validateInputs(
  inputFiles: string[],
  tool: ToolName,
  maxFileSize: number,
  bindingId: string | null,
  organizationId: string | null
): Promise<void> {
  const allowed = TOOL_INPUT_TYPES[tool];

  await Promise.all(
    inputFiles.map(async (key) => {
      let size: number;
      try {
        size = await headObjectSize(key, bindingId);
      } catch (err) {
        await reportRuntimeStorageFailure(organizationId, err);
        throw new AppError('An uploaded file could not be found. Please re-upload.', 400);
      }

      if (size <= 0) {
        await deleteObject(key, bindingId);
        throw new AppError('An uploaded file is empty.', 400);
      }
      if (size > maxFileSize) {
        await deleteObject(key, bindingId);
        const maxMb = Math.floor(maxFileSize / (1024 * 1024));
        throw new AppError(`A file exceeds your plan limit of ${maxMb}MB.`, 400);
      }

      const head = await readObjectHead(key, 1024, bindingId);
      const category = detectFileCategory(head);
      if (!allowed.includes(category)) {
        await deleteObject(key, bindingId);
        throw new AppError(`An uploaded file is not a valid input for this tool.`, 400);
      }
    })
  );
}

export const jobsService = {
  async createJob(userId: string, input: CreateJobInput) {
    const { tool, inputFiles, options } = input;

    const user = await db.select('tbl_user', 'id, plan', 'id = ?', [userId]);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const plan = asPlan(user.plan);
    const limits = PLAN_LIMITS[plan];
    const organizationId = await getOrganizationIdForUser(userId);
    const storageBindingId = await getActiveStorageBindingId(organizationId);
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await validateInputs(
      inputFiles,
      tool as ToolName,
      limits.maxFileSize,
      storageBindingId,
      organizationId
    );

    const reserve = await db.execute(
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

    const jobId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + env.JOB_TTL_MINUTES * 60 * 1000);
    const inputFilesStr = JSON.stringify(inputFiles);

    try {
      await db.insert('tbl_job', {
        id: jobId,
        userId: user.id,
        organizationId: organizationId ?? null,
        storageBindingId: storageBindingId ?? null,
        tool,
        status: 'QUEUED',
        inputFiles: inputFilesStr,
        expiresAt,
      });

      await pushToQueue(
        jobId,
        user.id,
        tool as ToolName,
        inputFiles,
        options,
        plan,
        organizationId,
        storageBindingId
      );
    } catch (err) {
      await db
        .execute(
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

  async getJobById(jobId: string, userId: string): Promise<any> {
    const job: any = await db.select('tbl_job', '*', 'id = ?', [jobId]);

    if (!job) {
      throw new AppError('Job not found', 404);
    }

    if (job.userId !== userId) {
      throw new AppError('Unauthorized access to job details', 403);
    }

    let inputFilesArray: string[] = [];
    try {
      if (job.inputFiles) {
        inputFilesArray =
          typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
      }
    } catch {
      // fallback
    }

    return {
      ...job,
      inputFiles: inputFilesArray,
    };
  },

  async getDownloadUrl(jobId: string, userId: string): Promise<{ url: string }> {
    const job = await db.select(
      'tbl_job',
      'userId, status, outputFile, storageBindingId',
      'id = ?',
      [jobId]
    );

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
    const url = await getSignedDownloadUrl(
      job.outputFile,
      fileName,
      undefined,
      job.storageBindingId ?? null
    );
    return { url };
  },
};
