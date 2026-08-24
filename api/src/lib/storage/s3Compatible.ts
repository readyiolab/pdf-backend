import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  GetBucketCorsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  CorsCheckResult,
  MultipartPart,
  ObjectHeadProbe,
  StorageProvider,
  StorageProviderKind,
} from './types';

export function requiredS3CorsConfig(appOrigin: string): string {
  return JSON.stringify(
    {
      CORSRules: [
        {
          AllowedOrigins: [appOrigin.replace(/\/$/, '')],
          AllowedMethods: ['GET', 'PUT', 'HEAD'],
          AllowedHeaders: ['Content-Type', 'Content-Length', 'Authorization', 'x-amz-*'],
          ExposeHeaders: ['ETag', 'Content-Length'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
    null,
    2
  );
}

export function createS3Client(opts: {
  region: string;
  endpoint?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}): S3Client {
  return new S3Client({
    region: opts.region || 'us-east-1',
    endpoint: opts.endpoint || undefined,
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
  });
}

export class S3CompatibleStorageProvider implements StorageProvider {
  constructor(
    public readonly kind: StorageProviderKind,
    public readonly bucket: string,
    private readonly client: S3Client
  ) {}

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds }
    );
  }

  async presignGet(
    key: string,
    opts: {
      ttlSeconds: number;
      fileName?: string;
      disposition?: 'attachment' | 'inline';
      contentType?: string;
    }
  ): Promise<string> {
    const disposition = opts.disposition ?? 'attachment';
    const filename = opts.fileName?.replace(/["\\]/g, '') ?? '';
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition:
          disposition === 'inline'
            ? 'inline'
            : filename
              ? `attachment; filename="${filename}"`
              : 'attachment',
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: opts.ttlSeconds }
    );
  }

  async headSize(key: string): Promise<number> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.ContentLength ?? 0;
  }

  async readHead(key: string, bytes = 1024): Promise<Buffer> {
    const { bytes: head } = await this.readHeadWithSize(key, bytes);
    return head;
  }

  async readHeadWithSize(key: string, bytes = 1024): Promise<ObjectHeadProbe> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
      })
    );
    const head = await streamToBuffer(res.Body as AsyncIterable<Buffer>);
    const size = parseSizeFromContentRange(res.ContentRange) ?? res.ContentLength ?? head.length;
    return { bytes: head, size };
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return streamToBuffer(res.Body as AsyncIterable<Buffer>);
  }

  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: destKey,
      })
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const unique = [...new Set(keys.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000);
      await this.client
        .send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          })
        )
        .catch(() => undefined);
    }
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      })
    );
    if (!res.UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return res.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds }
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[]
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
        },
      })
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        })
      )
      .catch(() => undefined);
  }

  async ensureAccessible(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      // Some providers (R2) are flaky on HeadBucket — fall back to list.
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 })
      );
    }
    const probeKey = `.pdftoolkit-health/${Date.now()}.txt`;
    await this.putObject(probeKey, Buffer.from('ok'), 'text/plain');
    await this.deleteObject(probeKey);
  }

  async checkCors(appOrigin: string): Promise<CorsCheckResult> {
    const origin = appOrigin.replace(/\/$/, '');
    const requiredConfig = requiredS3CorsConfig(origin);

    // Platform Spaces is configured by us — always ok for our own origin.
    if (this.kind === 'PLATFORM') {
      return { ok: true, requiredConfig };
    }

    try {
      const res = await this.client.send(new GetBucketCorsCommand({ Bucket: this.bucket }));
      const rules = res.CORSRules ?? [];
      const matches = rules.some((rule) => {
        const origins = rule.AllowedOrigins ?? [];
        const methods = (rule.AllowedMethods ?? []).map((m) => m.toUpperCase());
        const headers = (rule.AllowedHeaders ?? []).map((h) => h.toLowerCase());
        const originOk =
          origins.includes('*') ||
          origins.some((o) => o.replace(/\/$/, '').toLowerCase() === origin.toLowerCase());
        const putOk = methods.includes('PUT');
        const headerOk =
          headers.includes('*') ||
          headers.includes('content-type') ||
          headers.some((h) => h.includes('content-type'));
        return originOk && putOk && headerOk;
      });

      if (matches) return { ok: true, requiredConfig };
      return {
        ok: false,
        reason:
          'Bucket CORS does not allow PUT from your app origin with Content-Type. Apply the config below.',
        requiredConfig,
      };
    } catch (err: any) {
      const code = err?.name || err?.Code || '';
      // R2 / MinIO may not support GetBucketCors — tell the customer to set it manually.
      return {
        ok: false,
        reason:
          code === 'NoSuchCORSConfiguration' || code === 'NotImplemented'
            ? 'No CORS configuration found on this bucket. Apply the config below so browser uploads work.'
            : `Could not read bucket CORS (${code || err?.message || 'unknown'}). Apply the config below, then re-test.`,
        requiredConfig,
      };
    }
  }
}

async function streamToBuffer(body: AsyncIterable<Buffer> | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Parse "bytes 0-1023/12345678" → 12345678 */
function parseSizeFromContentRange(contentRange?: string): number | null {
  if (!contentRange) return null;
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
