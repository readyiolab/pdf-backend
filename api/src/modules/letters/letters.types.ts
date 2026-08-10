import { z } from 'zod';
import { LETTER_TYPES, SYSTEM_FIELDS } from './letterFields';

export const brandCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200),
    logoKey: z.string().max(512).nullable().optional(),
    letterheadKey: z.string().max(512).nullable().optional(),
    footerText: z.string().max(2000).nullable().optional(),
    signatoryName: z.string().max(255).nullable().optional(),
    signatoryDesignation: z.string().max(255).nullable().optional(),
    defaultFont: z.string().max(100).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const brandUpdateSchema = z.object({
  body: brandCreateSchema.shape.body.partial(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().min(1) }),
});

export const templateCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(LETTER_TYPES),
    contentJson: z.record(z.string(), z.any()).or(z.any()),
    fieldTokens: z.array(z.string()).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const templateUpdateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    contentJson: z.any().optional(),
    fieldTokens: z.array(z.string()).optional(),
    bumpVersion: z.boolean().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().min(1) }),
});

export const mappingSchema = z.object({
  body: z.object({
    mapping: z.record(z.string(), z.enum([...SYSTEM_FIELDS, ''] as [string, ...string[]]).or(z.string())),
  }),
  query: z.object({}).optional(),
  params: z.object({ batchId: z.string().min(1) }),
});

export const validateBatchSchema = z.object({
  body: z
    .object({
      sendModeSelected: z.boolean().optional(),
    })
    .optional()
    .default({}),
  query: z.object({}).optional(),
  params: z.object({ batchId: z.string().min(1) }),
});

export const approveGenerateSchema = z.object({
  body: z.object({
    approved: z.literal(true),
    passwordMode: z.enum(['NONE', 'FROM_COLUMN', 'EMPLOYEE_ID', 'LAST4_ID']).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ batchId: z.string().min(1) }),
});

export const sendBatchSchema = z.object({
  body: z.object({
    mode: z.enum(['GENERATE_ONLY', 'CREATE_DRAFTS', 'SEND_NOW']),
    subject: z.string().min(1).max(500).optional(),
    bodyHtml: z.string().max(50_000).optional(),
    confirmSendCount: z.number().int().positive().optional(),
    mailAccountId: z.string().min(1).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ batchId: z.string().min(1) }),
});

export const mailExchangeSchema = z.object({
  body: z.object({
    code: z.string().min(1),
    state: z.string().min(1),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
