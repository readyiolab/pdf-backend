import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { logger } from '../lib/logger';

export const s3 = new S3Client({
  endpoint: env.DO_SPACES_ENDPOINT,
  region: env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: env.DO_SPACES_KEY,
    secretAccessKey: env.DO_SPACES_SECRET,
  },
  forcePathStyle: false, // Required for DigitalOcean Spaces virtual hosting
});

const TEMP_DIR = path.join(process.cwd(), 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Downloads a file from DigitalOcean Spaces to a local temporary file.
 * Returns the absolute path of the local file.
 */
export async function downloadFromS3(fileKey: string): Promise<string> {
  logger.info({ fileKey }, 'Downloading file from DigitalOcean Spaces');
  
  const command = new GetObjectCommand({
    Bucket: env.DO_SPACES_BUCKET,
    Key: fileKey,
  });

  const response = await s3.send(command);
  if (!response.Body) {
    throw new Error(`Spaces Object Body is empty for key: ${fileKey}`);
  }

  const fileExt = path.extname(fileKey);
  const tempFileName = `${crypto.randomUUID()}${fileExt}`;
  const localFilePath = path.join(TEMP_DIR, tempFileName);

  const writeStream = fs.createWriteStream(localFilePath);
  await pipeline(response.Body as any, writeStream);

  logger.debug({ fileKey, localFilePath }, 'Spaces download complete');
  return localFilePath;
}

/**
 * Uploads a local file to DigitalOcean Spaces.
 * Returns the key of the uploaded file.
 */
export async function uploadToS3(
  localFilePath: string,
  destinationKey: string,
  contentType: string
): Promise<string> {
  logger.info({ localFilePath, destinationKey }, 'Uploading file to DigitalOcean Spaces');

  const fileStream = fs.createReadStream(localFilePath);
  
  const command = new PutObjectCommand({
    Bucket: env.DO_SPACES_BUCKET,
    Key: destinationKey,
    Body: fileStream,
    ContentType: contentType,
    ACL: 'public-read',
  });

  await s3.send(command);
  logger.debug({ destinationKey }, 'Spaces upload complete');

  return destinationKey;
}

/**
 * Utility to safely delete local temporary files.
 */
export function cleanupLocalFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug({ filePath }, 'Cleaned up local temp file');
    }
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to delete local temp file');
  }
}
export { env }; // Export to check bucket name if needed
