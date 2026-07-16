import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address').max(254),
    password: z
      .string()
      // bcrypt silently truncates beyond 72 bytes, so cap the length explicitly.
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long')
      .regex(/[A-Za-z]/, 'Password must contain a letter')
      .regex(/[0-9]/, 'Password must contain a number'),
    name: z.string().max(120).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    plan: 'FREE' | 'PRO';
    isGuest?: boolean;
  };
}
