import { z } from 'zod';

const fileMetaSchema = z.object({
  fileName: z.string().min(1, 'fileName is required'),
  contentType: z.string().min(1, 'contentType is required'),
  fileSize: z.number().int().positive('fileSize must be a positive integer'),
});

export const PRESIGN_BATCH_MAX = 20;

export const presignUploadSchema = z.object({
  body: fileMetaSchema,
});

export const presignBatchSchema = z.object({
  body: z.object({
    files: z
      .array(fileMetaSchema)
      .min(1, 'At least one file is required')
      .max(PRESIGN_BATCH_MAX, `At most ${PRESIGN_BATCH_MAX} files per batch`),
  }),
});

export const multipartInitSchema = z.object({
  body: fileMetaSchema,
});

export const multipartPresignPartsSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1),
    uploadId: z.string().min(1),
    partNumbers: z
      .array(z.number().int().min(1).max(10_000))
      .min(1)
      .max(100),
  }),
});

export const multipartCompleteSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1),
    uploadId: z.string().min(1),
    contentType: z.string().min(1).optional(),
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1),
          etag: z.string().min(1),
        })
      )
      .min(1),
  }),
});

export const multipartAbortSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1),
    uploadId: z.string().min(1),
  }),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>['body'];
export type PresignBatchInput = z.infer<typeof presignBatchSchema>['body'];
export type MultipartInitInput = z.infer<typeof multipartInitSchema>['body'];
export type MultipartPresignPartsInput = z.infer<typeof multipartPresignPartsSchema>['body'];
export type MultipartCompleteInput = z.infer<typeof multipartCompleteSchema>['body'];
export type MultipartAbortInput = z.infer<typeof multipartAbortSchema>['body'];

export type PresignResponse = {
  uploadUrl: string;
  fileKey: string;
};

export type MultipartInitResponse = {
  fileKey: string;
  uploadId: string;
  partSize: number;
};
