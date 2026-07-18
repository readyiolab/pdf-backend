import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
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

/**
 * Issues a signed GET URL that renders INLINE rather than downloading.
 *
 * The PDF viewer fetches the document bytes with this: forcing
 * `Content-Disposition: attachment` (as getSignedDownloadUrl does) would make
 * the browser save the file instead of letting pdf.js read it. Same privacy
 * model — short-lived, signed, never public.
 *
 * `ttlSeconds` defaults to the download TTL but is overridable, since a signing
 * session needs the URL to outlive a 5-minute download window.
 */
export async function getSignedViewUrl(
  key: string,
  ttlSeconds: number = env.DOWNLOAD_URL_TTL
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.DO_SPACES_BUCKET,
    Key: key,
    ResponseContentDisposition: 'inline',
    ResponseContentType: 'application/pdf',
  });
  return getSignedUrl(s3, command, { expiresIn: ttlSeconds });
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

/**
 * Downloads an object in full.
 *
 * Unlike `hashObject`, this must buffer: pdf-lib parses a random-access
 * document and cannot consume a stream. Only ever call it on signing documents,
 * which are capped at SIGNING_LIMITS.maxFileSize (50MB) — there is no such
 * guarantee for arbitrary keys.
 */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key })
  );
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Streams an object and returns its SHA-256, as lowercase hex.
 *
 * Streamed rather than buffered on purpose: signing documents run to 50MB, and
 * `Buffer.concat`-ing one into memory per upload is an easy way to OOM the API
 * under concurrency. Hashing incrementally keeps memory flat regardless of file
 * size.
 *
 * This does mean the bytes travel Spaces → API once more. Object storage
 * exposes no server-side SHA-256 (ETag is MD5, and isn't even that for
 * multipart uploads), so there is no way to obtain this without reading the
 * file. It's the price of the tamper-evidence guarantee.
 */
export async function hashObject(key: string): Promise<string> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key })
  );
  const hash = crypto.createHash('sha256');
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Best-effort deletion of a single object (used to purge rejected uploads). */
export async function deleteObject(key: string): Promise<void> {
  await s3
    .send(new DeleteObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key }))
    .catch(() => undefined);
}

/**
 * Best-effort batch deletion. Used when a signing document is deleted and its
 * original plus every signed version must go with it. S3 caps DeleteObjects at
 * 1000 keys per call, so we chunk.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    await s3
      .send(
        new DeleteObjectsCommand({
          Bucket: env.DO_SPACES_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        })
      )
      .catch(() => undefined);
  }
}
