import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  ContainerClient,
} from '@azure/storage-blob';
import type { CorsCheckResult, StorageProvider } from './types';
import { AppError } from '../../middleware/errorHandler.middleware';

export function requiredAzureCorsConfig(appOrigin: string): string {
  return JSON.stringify(
    [
      {
        allowedOrigins: [appOrigin.replace(/\/$/, '')],
        allowedMethods: ['GET', 'PUT', 'HEAD', 'OPTIONS'],
        allowedHeaders: ['*'],
        exposedHeaders: ['*'],
        maxAgeInSeconds: 3600,
      },
    ],
    null,
    2
  );
}

export class AzureBlobStorageProvider implements StorageProvider {
  readonly kind = 'AZURE_BLOB' as const;
  private container: ContainerClient;
  private service: BlobServiceClient;
  private accountName: string;
  private accountKey: string;

  constructor(opts: {
    bucket: string;
    connectionString?: string;
    accountName?: string;
    accountKey?: string;
  }) {
    this.bucket = opts.bucket;
    if (opts.connectionString) {
      this.service = BlobServiceClient.fromConnectionString(opts.connectionString);
      this.container = this.service.getContainerClient(opts.bucket);
      const match = /AccountName=([^;]+)/i.exec(opts.connectionString);
      const keyMatch = /AccountKey=([^;]+)/i.exec(opts.connectionString);
      this.accountName = match?.[1] || opts.accountName || '';
      this.accountKey = keyMatch?.[1] || opts.accountKey || '';
    } else if (opts.accountName && opts.accountKey) {
      this.accountName = opts.accountName;
      this.accountKey = opts.accountKey;
      const cred = new StorageSharedKeyCredential(opts.accountName, opts.accountKey);
      this.service = new BlobServiceClient(
        `https://${opts.accountName}.blob.core.windows.net`,
        cred
      );
      this.container = this.service.getContainerClient(opts.bucket);
    } else {
      throw new AppError('Azure Blob requires connectionString or accountName+accountKey', 400);
    }
  }

  readonly bucket: string;

  private credential(): StorageSharedKeyCredential {
    if (!this.accountName || !this.accountKey) {
      throw new AppError('Azure SAS requires account name and key', 500);
    }
    return new StorageSharedKeyCredential(this.accountName, this.accountKey);
  }

  private sasUrl(blobName: string, permissions: string, ttlSeconds: number, contentType?: string): string {
    const startsOn = new Date(Date.now() - 60_000);
    const expiresOn = new Date(Date.now() + ttlSeconds * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.bucket,
        blobName,
        permissions: BlobSASPermissions.parse(permissions),
        startsOn,
        expiresOn,
        contentType,
      },
      this.credential()
    ).toString();
    return `${this.container.getBlockBlobClient(blobName).url}?${sas}`;
  }

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    return this.sasUrl(key, 'cw', ttlSeconds, contentType);
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
    return this.sasUrl(key, 'r', opts.ttlSeconds, opts.contentType);
  }

  async headSize(key: string): Promise<number> {
    const props = await this.container.getBlobClient(key).getProperties();
    return props.contentLength ?? 0;
  }

  async readHead(key: string, bytes = 1024): Promise<Buffer> {
    const download = await this.container.getBlobClient(key).download(0, bytes);
    return streamToBuffer(download.readableStreamBody);
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    const download = await this.container.getBlobClient(key).download();
    return streamToBuffer(download.readableStreamBody);
  }

  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.container.getBlockBlobClient(key).uploadData(body, {
      blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
    });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const source = this.container.getBlobClient(sourceKey);
    const poller = await this.container.getBlobClient(destKey).beginCopyFromURL(source.url);
    await poller.pollUntilDone();
  }

  async deleteObject(key: string): Promise<void> {
    await this.container.getBlobClient(key).deleteIfExists();
  }

  async deleteObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.deleteObject(k)));
  }

  async ensureAccessible(): Promise<void> {
    const exists = await this.container.exists();
    if (!exists) {
      throw new AppError(`Azure container "${this.bucket}" does not exist`, 400);
    }
    const probe = `.pdftoolkit-health/${Date.now()}.txt`;
    await this.putObject(probe, Buffer.from('ok'), 'text/plain');
    await this.deleteObject(probe);
  }

  async checkCors(appOrigin: string): Promise<CorsCheckResult> {
    const origin = appOrigin.replace(/\/$/, '');
    const requiredConfig = requiredAzureCorsConfig(origin);
    try {
      const props = await this.service.getProperties();
      const rules = props.cors ?? [];
      const matches = rules.some((rule) => {
        const origins = rule.allowedOrigins?.split(',').map((o) => o.trim()) ?? [];
        const methods = (rule.allowedMethods ?? '')
          .split(',')
          .map((m) => m.trim().toUpperCase());
        const headers = (rule.allowedHeaders ?? '').toLowerCase();
        const originOk =
          origins.includes('*') ||
          origins.some((o) => o.replace(/\/$/, '').toLowerCase() === origin.toLowerCase());
        const putOk = methods.includes('PUT') || methods.includes('*');
        const headerOk = headers.includes('*') || headers.includes('content-type');
        return originOk && putOk && headerOk;
      });
      if (matches) return { ok: true, requiredConfig };
      return {
        ok: false,
        reason:
          'Azure Blob CORS does not allow PUT from your app origin. Apply the CORS rule below on the storage account.',
        requiredConfig,
      };
    } catch (err: any) {
      return {
        ok: false,
        reason: `Could not read Azure CORS (${err?.message || 'unknown'}). Apply the config below, then re-test.`,
        requiredConfig,
      };
    }
  }
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | undefined
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
