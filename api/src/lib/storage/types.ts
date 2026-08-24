/**
 * Object-storage abstraction for platform Spaces and Enterprise BYOC buckets.
 */

export type StorageProviderKind =
  | 'PLATFORM'
  | 'AWS_S3'
  | 'AZURE_BLOB'
  | 'GCS'
  | 'R2'
  | 'MINIO';

export interface S3CompatibleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AzureCredentials {
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
}

export interface GcsCredentials {
  /** Raw service-account JSON string */
  serviceAccountJson: string;
}

export type ProviderCredentials = S3CompatibleCredentials | AzureCredentials | GcsCredentials;

export interface StorageConfigInput {
  provider: StorageProviderKind;
  bucket?: string | null;
  region?: string | null;
  endpoint?: string | null;
  credentials?: ProviderCredentials | null;
}

export interface PresignPutResult {
  uploadUrl: string;
  fileKey: string;
  headers?: Record<string, string>;
}

export interface CorsCheckResult {
  ok: boolean;
  /** Human-readable reason when ok is false */
  reason?: string;
  /** Exact config the customer should apply (JSON string for S3-family, XML/JSON for Azure) */
  requiredConfig: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHeadProbe {
  bytes: Buffer;
  /** Full object size in bytes when the provider reports it (Content-Range / properties). */
  size: number;
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  readonly bucket: string;

  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<string>;
  presignGet(
    key: string,
    opts: {
      ttlSeconds: number;
      fileName?: string;
      disposition?: 'attachment' | 'inline';
      contentType?: string;
    }
  ): Promise<string>;
  headSize(key: string): Promise<number>;
  readHead(key: string, bytes?: number): Promise<Buffer>;
  /**
   * Single ranged GET that returns magic bytes + full object size (avoids HEAD + Range).
   */
  readHeadWithSize(key: string, bytes?: number): Promise<ObjectHeadProbe>;
  getObjectBytes(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>;
  copyObject(sourceKey: string, destKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;

  /** Start a multipart / block upload. Returns provider upload id. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Presign a single part PUT (S3 UploadPart or Azure stage-block). */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
    contentType?: string
  ): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** Health check used by Test Connection. */
  ensureAccessible(): Promise<void>;
  /**
   * Verify the bucket/container allows browser PUTs from appOrigin.
   * Returns structured guidance when CORS is missing or incomplete.
   */
  checkCors(appOrigin: string): Promise<CorsCheckResult>;
}
