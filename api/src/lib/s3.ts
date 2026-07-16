import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

export const s3 = new S3Client({
  endpoint: env.DO_SPACES_ENDPOINT,
  region: env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: env.DO_SPACES_KEY,
    secretAccessKey: env.DO_SPACES_SECRET,
  },
  forcePathStyle: false, // Required for DigitalOcean Spaces virtual hosting
});

/**
 * Issues a short-lived, signed GET URL for a private object. Results are stored
 * privately (no public-read ACL); only the job owner receives a signed URL, and
 * it expires quickly (DOWNLOAD_URL_TTL). This replaces the previous public URLs.
 */
export async function getSignedDownloadUrl(
  key: string,
  fileName?: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.DO_SPACES_BUCKET,
    Key: key,
    // Force a download with a clean filename rather than inline rendering.
    ResponseContentDisposition: fileName
      ? `attachment; filename="${fileName.replace(/["\\]/g, '')}"`
      : 'attachment',
  });
  return getSignedUrl(s3, command, { expiresIn: env.DOWNLOAD_URL_TTL });
}

/** Returns the size (bytes) of an object without downloading it. */
export async function headObjectSize(key: string): Promise<number> {
  const res = await s3.send(
    new HeadObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key })
  );
  return res.ContentLength ?? 0;
}

/**
 * Reads only the leading bytes of an object (ranged GET) so we can verify the
 * real file type from its magic bytes without downloading the whole file.
 */
export async function readObjectHead(key: string, bytes = 1024): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: env.DO_SPACES_BUCKET,
      Key: key,
      Range: `bytes=0-${bytes - 1}`,
    })
  );
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Best-effort deletion of a single object (used to purge rejected uploads). */
export async function deleteObject(key: string): Promise<void> {
  await s3
    .send(new DeleteObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key }))
    .catch(() => undefined);
}
