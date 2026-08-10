import crypto from 'crypto';
import { z } from 'zod';

export const ORG_ROLES = ['OWNER', 'ADMIN', 'HR_MANAGER', 'VIEWER'] as const;
export type OrgRoleName = (typeof ORG_ROLES)[number];

export const createOrgSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(200),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const inviteMemberSchema = z.object({
  body: z.object({
    email: z.string().trim().email().max(255),
    role: z.enum(['ADMIN', 'HR_MANAGER', 'VIEWER']),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const acceptInviteSchema = z.object({
  body: z.object({
    token: z.string().trim().min(16).max(128),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const changeRoleSchema = z.object({
  body: z.object({
    role: z.enum(['ADMIN', 'HR_MANAGER', 'VIEWER']),
  }),
  query: z.object({}).optional(),
  params: z.object({
    membershipId: z.string().uuid().or(z.string().min(1)),
  }),
});

export function newId(): string {
  return crypto.randomUUID();
}
