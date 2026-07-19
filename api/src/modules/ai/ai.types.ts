import { z } from 'zod';

export const aiPresignSchema = z.object({
  body: z.object({
    fileName: z.string().min(1, 'fileName is required').max(255),
    contentType: z.literal('application/pdf', {
      errorMap: () => ({ message: 'Only PDF files are supported.' }),
    }),
    fileSize: z.number().int().positive('fileSize must be a positive integer').max(30 * 1024 * 1024, 'This PDF is too large for AI processing.'),
  }),
});

export const summarizeSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1, 'fileKey is required'),
    // Preset only — the prompt is server-owned, so a caller can't inject one.
    style: z.enum(['concise', 'detailed', 'bullets']).default('concise'),
  }),
});

export const explainSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1, 'fileKey is required'),
    audience: z.enum(['simple', 'legal', 'technical']).default('simple'),
  }),
});

export const chatSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1, 'fileKey is required'),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(10_000),
        })
      )
      .min(1, 'At least one message is required')
      .max(40, 'Conversation is too long.'),
  }),
});

export type SummarizeInput = z.infer<typeof summarizeSchema>['body'];
export type ExplainInput = z.infer<typeof explainSchema>['body'];
export type ChatInput = z.infer<typeof chatSchema>['body'];
