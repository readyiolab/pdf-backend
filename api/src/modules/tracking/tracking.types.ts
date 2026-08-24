import { z } from 'zod';

const attributionFields = {
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
};

const emptyQuery = z.object({}).optional();
const emptyParams = z.object({}).optional();

export const visitSchema = z.object({
  body: z.object(attributionFields),
  query: emptyQuery,
  params: emptyParams,
});

export const profileUpdateSchema = z.object({
  body: z.object({
    phone: z.string().max(64).optional().nullable(),
    company: z.string().max(255).optional().nullable(),
    addressLine1: z.string().max(255).optional().nullable(),
    addressLine2: z.string().max(255).optional().nullable(),
    city: z.string().max(128).optional().nullable(),
    state: z.string().max(128).optional().nullable(),
    postalCode: z.string().max(32).optional().nullable(),
    country: z.string().max(64).optional().nullable(),
  }),
  query: emptyQuery,
  params: emptyParams,
});

export type VisitInput = z.infer<typeof visitSchema>['body'];
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>['body'];
