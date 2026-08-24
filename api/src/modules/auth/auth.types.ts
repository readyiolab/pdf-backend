import { z } from 'zod';

const attributionFields = z
  .object({
    visitorId: z.string().min(8).max(64).optional().nullable(),
    landingPath: z.string().max(512).optional().nullable(),
    referrer: z.string().max(1024).optional().nullable(),
    utmSource: z.string().max(255).optional().nullable(),
    utmMedium: z.string().max(255).optional().nullable(),
    utmCampaign: z.string().max(255).optional().nullable(),
    utmTerm: z.string().max(255).optional().nullable(),
    utmContent: z.string().max(255).optional().nullable(),
    gclid: z.string().max(255).optional().nullable(),
    fbclid: z.string().max(255).optional().nullable(),
    msclkid: z.string().max(255).optional().nullable(),
  })
  .optional();

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address').max(254),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long')
      .regex(/[A-Za-z]/, 'Password must contain a letter')
      .regex(/[0-9]/, 'Password must contain a number'),
    name: z.string().max(120).optional(),
    attribution: attributionFields,
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    attribution: attributionFields,
  }),
});

export const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(16).max(128),
  }),
});

export const googleAuthSchema = z.object({
  body: z.object({
    credential: z.string().min(20, 'Google credential is required'),
    attribution: attributionFields,
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  plan: 'FREE' | 'PRO';
  emailVerified: boolean;
  isGuest?: boolean;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}
