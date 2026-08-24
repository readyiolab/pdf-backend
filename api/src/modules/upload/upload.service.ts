import crypto from 'crypto';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';
import { logger } from '../../lib/logger';
import {
  PresignUploadInput,
  PresignBatchInput,
  PresignResponse,
  MultipartInitInput,
  MultipartInitResponse,
  MultipartPresignPartsInput,
  MultipartCompleteInput,
  MultipartAbortInput,
} from './upload.types';
import { asPlan, getStorageForUser, reportRuntimeStorageFailure } from '../../lib/storage';
import { isOwnedUploadKey } from '../../lib/objectKeyOwnership';
import type { Plan } from '../../../../shared/types';
import type { StorageProvider } from '../../lib/storage/types';

/** Part size for multipart uploads (8 MiB). S3 minimum for non-last parts is 5 MiB. */
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
/** Files at or above this size use multipart instead of a single PUT. */
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024;

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
}

function buildFileKey(
  organizationId: string | null,
  keyPrefix: string,
  fileName: string
): string {
  const uniqueId = crypto.randomUUID();
  const sanitizedName = sanitizeFileName(fileName);
  return organizationId
    ? `${keyPrefix}/uploads/${uniqueId}_${sanitizedName}`
    : `${keyPrefix}/${uniqueId}_${sanitizedName}`;
}

function assertPlanSize(plan: Plan | 'FREE' | 'PRO', fileSize: number): Plan {
  const normalizedPlan = asPlan(plan);
  const limits = PLAN_LIMITS[normalizedPlan];
  if (fileSize > limits.maxFileSize) {
    const maxMb = limits.maxFileSize / (1024 * 1024);
    throw new AppError(
      `File size exceeds your plan limit of ${maxMb}MB. Please upgrade for larger files.`,
      400
    );
  }
  return normalizedPlan;
}

async function withStorage<T>(
  userId: string,
  fn: (ctx: {
    storage: StorageProvider;
    organizationId: string | null;
    keyPrefix: string;
  }) => Promise<T>
): Promise<T> {
  const { storage, organizationId, keyPrefix } = await getStorageForUser(userId);
  try {
    return await fn({ storage, organizationId, keyPrefix });
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    await reportRuntimeStorageFailure(organizationId, err);
    throw new AppError(err?.message || 'Storage operation failed', 500);
  }
}

export const uploadService = {
  async generatePresignedUrl(
    userId: string,
    plan: Plan | 'FREE' | 'PRO',
    input: PresignUploadInput
  ): Promise<PresignResponse> {
    const started = Date.now();
    assertPlanSize(plan, input.fileSize);

    const result = await withStorage(userId, async ({ storage, organizationId, keyPrefix }) => {
      const fileKey = buildFileKey(organizationId, keyPrefix, input.fileName);
      const uploadUrl = await storage.presignPut(
        fileKey,
        input.contentType,
        env.PRESIGN_TTL_SECONDS
      );
      return { uploadUrl, fileKey };
    });

    logger.info(
      { userId, fileSize: input.fileSize, presign_ms: Date.now() - started },
      'upload.presign'
    );
    return result;
  },

  async generatePresignedUrlBatch(
    userId: string,
    plan: Plan | 'FREE' | 'PRO',
    input: PresignBatchInput
  ): Promise<{ uploads: PresignResponse[] }> {
    const started = Date.now();
    for (const f of input.files) {
      assertPlanSize(plan, f.fileSize);
    }

    const uploads = await withStorage(userId, async ({ storage, organizationId, keyPrefix }) => {
      return Promise.all(
        input.files.map(async (f) => {
          const fileKey = buildFileKey(organizationId, keyPrefix, f.fileName);
          const uploadUrl = await storage.presignPut(
            fileKey,
            f.contentType,
            env.PRESIGN_TTL_SECONDS
          );
          return { uploadUrl, fileKey };
        })
      );
    });

    logger.info(
      {
        userId,
        count: input.files.length,
        totalBytes: input.files.reduce((s, f) => s + f.fileSize, 0),
        presign_ms: Date.now() - started,
      },
      'upload.presign_batch'
    );
    return { uploads };
  },

  async initMultipart(
    userId: string,
    plan: Plan | 'FREE' | 'PRO',
    input: MultipartInitInput
  ): Promise<MultipartInitResponse> {
    const started = Date.now();
    assertPlanSize(plan, input.fileSize);

    const result = await withStorage(userId, async ({ storage, organizationId, keyPrefix }) => {
      const fileKey = buildFileKey(organizationId, keyPrefix, input.fileName);
      const uploadId = await storage.createMultipartUpload(fileKey, input.contentType);
      return { fileKey, uploadId, partSize: MULTIPART_PART_SIZE };
    });

    logger.info(
      {
        userId,
        fileSize: input.fileSize,
        fileKey: result.fileKey,
        multipart_init_ms: Date.now() - started,
      },
      'upload.multipart_init'
    );
    return result;
  },

  async presignMultipartParts(
    userId: string,
    input: MultipartPresignPartsInput
  ): Promise<{ parts: { partNumber: number; uploadUrl: string }[] }> {
    return withStorage(userId, async ({ storage, organizationId }) => {
      if (!isOwnedUploadKey(input.fileKey, userId, organizationId)) {
        throw new AppError('Invalid file key for this account.', 403);
      }
      const parts = await Promise.all(
        input.partNumbers.map(async (partNumber) => {
          const uploadUrl = await storage.presignUploadPart(
            input.fileKey,
            input.uploadId,
            partNumber,
            env.PRESIGN_TTL_SECONDS
          );
          return { partNumber, uploadUrl };
        })
      );
      return { parts };
    });
  },

  async completeMultipart(userId: string, input: MultipartCompleteInput): Promise<{ fileKey: string }> {
    const started = Date.now();
    await withStorage(userId, async ({ storage, organizationId }) => {
      if (!isOwnedUploadKey(input.fileKey, userId, organizationId)) {
        throw new AppError('Invalid file key for this account.', 403);
      }
      await storage.completeMultipartUpload(
        input.fileKey,
        input.uploadId,
        input.parts,
        input.contentType
      );
    });
    logger.info(
      { userId, fileKey: input.fileKey, multipart_complete_ms: Date.now() - started },
      'upload.multipart_complete'
    );
    return { fileKey: input.fileKey };
  },

  async abortMultipart(userId: string, input: MultipartAbortInput): Promise<void> {
    await withStorage(userId, async ({ storage, organizationId }) => {
      if (!isOwnedUploadKey(input.fileKey, userId, organizationId)) {
        throw new AppError('Invalid file key for this account.', 403);
      }
      await storage.abortMultipartUpload(input.fileKey, input.uploadId);
    });
  },
};
