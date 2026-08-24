import { db } from '../../lib/mysql';
import { pushToQueue } from '../../lib/queue';
import {
  readObjectHeadWithSize,
  deleteObject,
  getSignedDownloadUrl,
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
import { isOwnedUploadKey } from '../../lib/objectKeyOwnership';
import { logger } from '../../lib/logger';
import crypto from 'crypto';

export type CreateJobContext = {
  plan?: 'FREE' | 'PRO' | 'ENTERPRISE';
  organizationId?: string | null;
  storageBindingId?: string | null;
};

async function validateInputs(
  inputFiles: string[],
  tool: ToolName,
  maxFileSize: number,
  bindingId: string | null,
  organizationId: string | null,
  userId: string
): Promise<void> {
  const allowed = TOOL_INPUT_TYPES[tool];

  await Promise.all(
    inputFiles.map(async (key) => {
      if (!isOwnedUploadKey(key, userId, organizationId)) {
        throw new AppError('Invalid file key for this account.', 403);
      }

      let size: number;
      let head: Buffer;
      try {
        // Single ranged GET — size from Content-Range + magic bytes (was HEAD + Range).
        const probe = await readObjectHeadWithSize(key, 1024, bindingId);
        size = probe.size;
        head = probe.bytes;
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

      const category = detectFileCategory(head);
      if (!allowed.includes(category)) {
        await deleteObject(key, bindingId);
        throw new AppError(`An uploaded file is not a valid input for this tool.`, 400);
      }
    })
  );
}

export const jobsService = {
  async createJob(userId: string, input: CreateJobInput, ctx: CreateJobContext = {}) {
    const started = Date.now();
    const { tool, inputFiles, options } = input;

    // Prefer auth-cache context from middleware; fall back to DB only when missing.
    let plan = ctx.plan ? asPlan(ctx.plan) : null;
    let organizationId =
      ctx.organizationId !== undefined ? ctx.organizationId : undefined;
    let storageBindingId =
      ctx.storageBindingId !== undefined ? ctx.storageBindingId : undefined;

    if (!plan) {
      const user = await db.select('tbl_user', 'id, plan', 'id = ?', [userId]);
      if (!user) {
        throw new AppError('User not found', 404);
      }
      plan = asPlan(user.plan);
    }

    if (organizationId === undefined) {
      organizationId = await getOrganizationIdForUser(userId);
    }
    if (storageBindingId === undefined) {
      storageBindingId = await getActiveStorageBindingId(organizationId);
    }

    const limits = PLAN_LIMITS[plan];
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const validateStarted = Date.now();
    await validateInputs(
      inputFiles,
      tool as ToolName,
      limits.maxFileSize,
      storageBindingId,
      organizationId,
      userId
    );
    const validate_inputs_ms = Date.now() - validateStarted;

    const reserve = await db.execute(
      `UPDATE tbl_user
         SET dailyOpsUsed   = IF(dailyOpsResetAt < ?, 1, dailyOpsUsed + 1),
             dailyOpsResetAt = IF(dailyOpsResetAt < ?, ?, dailyOpsResetAt)
       WHERE id = ?
         AND (dailyOpsResetAt < ? OR dailyOpsUsed < ?)`,
      [windowCutoff, windowCutoff, now, userId, windowCutoff, limits.maxDailyOps]
    );

    if (reserve.affectedRows === 0) {
      throw new AppError(
        `Daily operations limit of ${limits.maxDailyOps} reached for your ${plan} plan. Please upgrade to PRO.`,
        403
      );
    }

    const jobId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + env.JOB_TTL_MINUTES * 60 * 1000);
    const inputFilesStr = JSON.stringify(inputFiles);

    try {
      await db.insert('tbl_job', {
        id: jobId,
        userId,
        organizationId: organizationId ?? null,
        storageBindingId: storageBindingId ?? null,
        tool,
        status: 'QUEUED',
        inputFiles: inputFilesStr,
        expiresAt,
      });

      const enqueueStarted = Date.now();
      await pushToQueue(
        jobId,
        userId,
        tool as ToolName,
        inputFiles,
        options,
        plan,
        organizationId,
        storageBindingId
      );
      const enqueue_ms = Date.now() - enqueueStarted;

      logger.info(
        {
          jobId,
          tool,
          fileCount: inputFiles.length,
          validate_inputs_ms,
          enqueue_ms,
          create_job_ms: Date.now() - started,
        },
        'jobs.create'
      );
    } catch (err) {
      await db
        .execute(
          'UPDATE tbl_user SET dailyOpsUsed = GREATEST(dailyOpsUsed - 1, 0) WHERE id = ?',
          [userId]
        )
        .catch(() => undefined);
      throw err;
    }

    return {
      id: jobId,
      userId,
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
      throw new AppError('Job is not ready for download', 400);
    }

    const url = await getSignedDownloadUrl(
      job.outputFile,
      undefined,
      env.DOWNLOAD_URL_TTL,
      job.storageBindingId
    );
    return { url };
  },
};
