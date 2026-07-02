import { z } from 'zod';

export const presignUploadSchema = z.object({
  body: z.object({
    fileName: z.string().min(1, 'fileName is required'),
    contentType: z.string().min(1, 'contentType is required'),
    fileSize: z.number().int().positive('fileSize must be a positive integer'),
  }),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>['body'];
export type PresignResponse = {
  uploadUrl: string;
  fileKey: string;
};
