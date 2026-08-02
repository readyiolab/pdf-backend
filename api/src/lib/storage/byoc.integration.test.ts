/**
 * Integration tests against MinIO + Azurite.
 *
 * Start fixtures:
 *   docker compose -f docker-compose.byoc-test.yml up -d
 *
 * Run:
 *   BYOC_INTEGRATION=1 npm test -- src/lib/storage/byoc.integration.test.ts
 *
 * Skips automatically when BYOC_INTEGRATION is unset (CI default).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

const enabled = process.env.BYOC_INTEGRATION === '1';

const MINIO_ENDPOINT = process.env.BYOC_MINIO_ENDPOINT || 'http://127.0.0.1:9000';
const MINIO_ACCESS = process.env.BYOC_MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET = process.env.BYOC_MINIO_SECRET_KEY || 'minioadmin';
const AZURITE_ACCOUNT = process.env.BYOC_AZURITE_ACCOUNT || 'devstoreaccount1';
const AZURITE_KEY =
  process.env.BYOC_AZURITE_KEY ||
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const AZURITE_BLOB =
  process.env.BYOC_AZURITE_BLOB_URL ||
  `http://127.0.0.1:10000/${AZURITE_ACCOUNT}`;

async function streamToBuffer(body: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('BYOC MinIO / Azurite integration', { skip: !enabled }, () => {
  const bucketA = `byoc-a-${Date.now()}`;
  const bucketB = `byoc-b-${Date.now()}`;
  let minio: S3Client;

  before(async () => {
    minio = new S3Client({
      region: 'us-east-1',
      endpoint: MINIO_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
    });
    await minio.send(new CreateBucketCommand({ Bucket: bucketA }));
    await minio.send(new CreateBucketCommand({ Bucket: bucketB }));
  });

  it('uploads to binding-a and reads back after "provider switch" to binding-b', async () => {
    const key = `org-test/uploads/pre-switch.txt`;
    const body = Buffer.from('pre-switch-object-v1');

    // Binding A write
    await minio.send(
      new PutObjectCommand({ Bucket: bucketA, Key: key, Body: body, ContentType: 'text/plain' })
    );

    // Simulate switch: new writes go to bucketB, but old key still resolved via binding A
    await minio.send(
      new PutObjectCommand({
        Bucket: bucketB,
        Key: 'org-test/uploads/post-switch.txt',
        Body: Buffer.from('new'),
        ContentType: 'text/plain',
      })
    );

    const pre = await minio.send(new GetObjectCommand({ Bucket: bucketA, Key: key }));
    const preBytes = await streamToBuffer(pre.Body);
    assert.equal(preBytes.toString('utf8'), 'pre-switch-object-v1');

    // Active binding (B) does not contain the old key — proves binding-scoped reads are required
    let missing = false;
    try {
      await minio.send(new GetObjectCommand({ Bucket: bucketB, Key: key }));
    } catch {
      missing = true;
    }
    assert.equal(missing, true);
  });

  it('MinIO bucket is reachable (HeadBucket)', async () => {
    await minio.send(new HeadBucketCommand({ Bucket: bucketA }));
  });

  it('Azurite container write + read round-trip', async () => {
    const cred = new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY);
    const service = new BlobServiceClient(AZURITE_BLOB, cred);
    const containerName = `byoc${Date.now()}`;
    const container = service.getContainerClient(containerName);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient('pre-switch.txt');
    await blob.uploadData(Buffer.from('azure-v1'), {
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });
    const downloaded = await blob.downloadToBuffer();
    assert.equal(downloaded.toString('utf8'), 'azure-v1');
  });
});
