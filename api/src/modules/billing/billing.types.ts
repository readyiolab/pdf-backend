import { z } from 'zod';

export const checkoutSchema = z.object({
  body: z.object({
    planId: z.string().min(1, 'planId is required'), // Razorpay plan_id (e.g. plan_N1234abc)
  }),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>['body'];
