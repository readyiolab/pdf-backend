import { z } from 'zod';
import {
  SIGN_FIELD_TYPES,
  SIGNING_LIMITS,
} from '../../../../shared/signing';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 0..1 page-relative fraction. See SignFieldGeometry for why these aren't pixels. */
const fraction = z.number().min(0).max(1);

export const presignDocumentSchema = z.object({
  body: z.object({
    fileName: z.string().min(1, 'fileName is required').max(255),
    contentType: z.string().min(1, 'contentType is required'),
    fileSize: z
      .number()
      .int()
      .positive('fileSize must be a positive integer')
      .max(SIGNING_LIMITS.maxFileSize, 'File exceeds the maximum signing document size'),
  }),
});

export const createDocumentSchema = z.object({
  body: z.object({
    fileKey: z.string().min(1, 'fileKey is required'),
    fileName: z.string().min(1, 'fileName is required').max(255),
    title: z.string().min(1).max(SIGNING_LIMITS.maxTitleLength).optional(),
    // Advisory only — the client knows the page count after pdf.js parses the
    // file. Re-derived authoritatively at finalization.
    pageCount: z.number().int().positive().max(10000).optional(),
  }),
});

export const listDocumentsSchema = z.object({
  query: z.object({
    status: z
      .enum(['DRAFT', 'SENT', 'COMPLETED', 'DECLINED', 'EXPIRED', 'VOIDED'])
      .optional(),
    search: z.string().max(200).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const documentIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document id'),
  }),
});

/**
 * For routes that take an optional ?version=N.
 *
 * The `query` block is NOT optional decoration. `validate` assigns
 * `req.query = parsed.query`, and zod strips any key the schema doesn't
 * declare — so validating with a params-only schema sets `req.query` to
 * `undefined`, and the handler throws on `req.query.version`. Any route whose
 * handler reads the query string must declare it here.
 */
export const documentVersionSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document id'),
  }),
  query: z.object({
    version: z.coerce.number().int().positive().optional(),
  }),
});

export const updateDocumentSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid document id') }),
  body: z
    .object({
      title: z.string().min(1).max(SIGNING_LIMITS.maxTitleLength).optional(),
      message: z.string().max(SIGNING_LIMITS.maxMessageLength).nullable().optional(),
      flowType: z.enum(['SEQUENTIAL', 'PARALLEL']).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'No fields to update'),
});

const recipientBody = z.object({
  name: z.string().min(1, 'Recipient name is required').max(255),
  email: z.string().email('A valid recipient email is required').max(255),
  // E.164. Deliberately strict: WATI and every SMS gateway reject anything else,
  // and a number that fails at send time is far more expensive to discover than
  // one rejected here while the owner is still looking at the form.
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in international format, e.g. +919876543210')
    .optional(),
  role: z.enum(['SIGNER', 'APPROVER', 'VIEWER', 'CC']).default('SIGNER'),
  color: z.string().regex(HEX_COLOR, 'color must be a #rrggbb hex value').optional(),
  signingOrder: z.number().int().min(1).max(SIGNING_LIMITS.maxRecipientsPerDocument).optional(),
  authMethod: z.enum(['NONE', 'EMAIL_OTP', 'SMS_OTP', 'ACCESS_CODE']).default('NONE'),
  /** Required when authMethod is ACCESS_CODE. Stored bcrypt-hashed, never returned. */
  accessCode: z.string().min(4).max(64).optional(),
});

export const addRecipientSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid document id') }),
  body: recipientBody
    .refine((b) => b.authMethod !== 'ACCESS_CODE' || Boolean(b.accessCode), {
      message: 'accessCode is required when authMethod is ACCESS_CODE',
      path: ['accessCode'],
    })
    // Caught here rather than at send time: an SMS_OTP signer with no number is
    // a document that silently cannot be signed, discovered only once it's out.
    .refine((b) => b.authMethod !== 'SMS_OTP' || Boolean(b.phone), {
      message: 'A phone number is required when authMethod is SMS_OTP',
      path: ['phone'],
    }),
});

export const updateRecipientSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document id'),
    recipientId: z.string().uuid('Invalid recipient id'),
  }),
  body: recipientBody.partial().refine(
    (b) => Object.keys(b).length > 0,
    'No fields to update'
  ),
});

export const recipientIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document id'),
    recipientId: z.string().uuid('Invalid recipient id'),
  }),
});

const fieldConfigSchema = z
  .object({
    placeholder: z.string().max(200).optional(),
    defaultValue: z.string().max(2000).optional(),
    options: z.array(z.string().max(200)).max(100).optional(),
    validation: z
      .object({
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(0).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        pattern: z.string().max(500).optional(),
      })
      .optional(),
    font: z
      .object({
        family: z.string().max(100).optional(),
        size: z.number().min(4).max(96).optional(),
        weight: z.enum(['normal', 'bold']).optional(),
        style: z.enum(['normal', 'italic']).optional(),
        color: z.string().regex(HEX_COLOR).optional(),
        align: z.enum(['left', 'center', 'right']).optional(),
      })
      .optional(),
    border: z
      .object({
        width: z.number().min(0).max(10).optional(),
        color: z.string().regex(HEX_COLOR).optional(),
        style: z.enum(['solid', 'dashed', 'none']).optional(),
        radius: z.number().min(0).max(50).optional(),
      })
      .optional(),
    backgroundColor: z.string().optional(),
    dateFormat: z.string().max(50).optional(),
  })
  .strict();

const fieldSchema = z.object({
  // Client-generated so the designer can create a field optimistically and
  // keep the same identity across autosaves.
  id: z.string().uuid('Invalid field id'),
  recipientId: z.string().uuid().nullable().optional(),
  type: z.enum(SIGN_FIELD_TYPES as [string, ...string[]]),
  label: z.string().max(255).default(''),
  page: z.number().int().positive(),
  x: fraction,
  y: fraction,
  width: fraction.refine((v) => v > 0, 'width must be greater than 0'),
  height: fraction.refine((v) => v > 0, 'height must be greater than 0'),
  required: z.boolean().default(true),
  locked: z.boolean().default(false),
  config: fieldConfigSchema.default({}),
});

/**
 * Bulk replace. The designer owns the full field set for a document and saves
 * it wholesale, which makes deletes and reorders trivially consistent — no
 * per-field diffing across the wire.
 */
export const saveFieldsSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid document id') }),
  body: z.object({
    fields: z
      .array(fieldSchema)
      .max(
        SIGNING_LIMITS.maxFieldsPerDocument,
        `A document cannot have more than ${SIGNING_LIMITS.maxFieldsPerDocument} fields`
      )
      .superRefine((fields, ctx) => {
        const seen = new Set<string>();
        for (const f of fields) {
          if (seen.has(f.id)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate field id ${f.id}` });
          }
          seen.add(f.id);
          // Reject geometry that runs off the page edge — the designer clamps,
          // so this only fires on a malformed/hand-crafted payload.
          if (f.x + f.width > 1.0001 || f.y + f.height > 1.0001) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Field ${f.id} extends beyond the page bounds`,
            });
          }
        }
      }),
  }),
});

export const auditQuerySchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid document id') }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }),
});

export type PresignDocumentInput = z.infer<typeof presignDocumentSchema>['body'];
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>['body'];
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>['query'];
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>['body'];
export type AddRecipientInput = z.infer<typeof addRecipientSchema>['body'];
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>['body'];
export type SaveFieldsInput = z.infer<typeof saveFieldsSchema>['body'];
