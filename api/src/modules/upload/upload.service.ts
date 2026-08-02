import crypto from 'crypto';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';
import { PresignUploadInput, PresignResponse } from './upload.types';
import { asPlan, getStorageForUser, reportRuntimeStorageFailure } from '../../lib/storage';
import type { Plan } from '../../../../shared/types';

export const uploadService = {
  async generatePresignedUrl(
    userId: string,
    plan: Plan | 'FREE' | 'PRO',
    input: PresignUploadInput
  ): Promise<PresignResponse> {
    const { fileName, contentType, fileSize } = input;
    const normalizedPlan = asPlan(plan);

    const limits = PLAN_LIMITS[normalizedPlan];
    if (fileSize > limits.maxFileSize) {
      const maxMb = limits.maxFileSize / (1024 * 1024);
      throw new AppError(
        `File size exceeds your plan limit of ${maxMb}MB. Please upgrade for larger files.`,
        400
      );
    }

    const { storage, organizationId, keyPrefix } = await getStorageForUser(userId);
    const uniqueId = crypto.randomUUID();
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    // Platform keeps the historical prefix; BYOC uses org-{id}/uploads/…
    const fileKey = organizationId
      ? `${keyPrefix}/uploads/${uniqueId}_${sanitizedName}`
      : `${keyPrefix}/${uniqueId}_${sanitizedName}`;

    try {
      const uploadUrl = await storage.presignPut(fileKey, contentType, env.PRESIGN_TTL_SECONDS);
      return { uploadUrl, fileKey };
    } catch (err: any) {
      await reportRuntimeStorageFailure(organizationId, err);
      throw new AppError(`Failed to generate upload URL: ${err.message}`, 500);
    }
  },
};
