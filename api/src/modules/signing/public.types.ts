import { z } from 'zod';

/**
 * A signing token is 32 random bytes as hex. Validating the shape here means a
 * malformed token is rejected before it ever reaches a database lookup.
 */
const signingToken = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Invalid signing link');

export const signTokenParamSchema = z.object({
  params: z.object({ token: signingToken }),
});

export const verifyOtpSchema = z.object({
  params: z.object({ token: signingToken }),
  body: z.object({
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  }),
});

export const completeSchema = z.object({
  params: z.object({ token: signingToken }),
  body: z.object({
    // Keyed by field id. Values are re-validated per field against that field's
    // own config in publicSigningService.complete — this only bounds the shape.
    values: z.record(z.string().uuid(), z.string()),
  }),
});

export const declineSchema = z.object({
  params: z.object({ token: signingToken }),
  body: z.object({
    reason: z.string().max(1000).optional(),
  }),
});
