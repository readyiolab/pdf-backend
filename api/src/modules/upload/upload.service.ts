import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { s3 } from '../../lib/s3';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '@shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';
import { PresignUploadInput, PresignResponse } from './upload.types';

export const uploadService = {
  async generatePresignedUrl(
    userId: string,
    plan: 'FREE' | 'PRO',
    input: PresignUploadInput
  ): Promise<PresignResponse> {
    const { fileName, contentType, fileSize } = input;

    // 1. Validate file size based on user plan
    const limits = PLAN_LIMITS[plan];
    if (fileSize > limits.maxFileSize) {
      const maxMb = limits.maxFileSize / (1024 * 1024);
      throw new AppError(
        `File size exceeds your plan limit of ${maxMb}MB. Please upgrade for larger files.`,
        400
      );
    }

    // 2. Generate unique name-wise file key
    const uniqueId = crypto.randomUUID();
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    // Using descriptive namespace folders inside the DigitalOcean Space
    const fileKey = `pdf-saas-uploads/user-${userId}/${uniqueId}_${sanitizedName}`;

    // 3. Generate pre-signed URL (valid for 15 minutes)
    const command = new PutObjectCommand({
      Bucket: env.DO_SPACES_BUCKET,
      Key: fileKey,
      ContentType: contentType,
    });

    try {
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
      return {
        uploadUrl,
        fileKey,
      };
    } catch (err: any) {
      throw new AppError(`Failed to generate upload URL: ${err.message}`, 500);
    }
  },
};
