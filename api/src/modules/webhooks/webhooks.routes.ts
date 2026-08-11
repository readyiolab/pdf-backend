import { Router } from 'express';
import express from 'express';
import { webhooksController } from './webhooks.controller';
import { webhookRateLimiter } from '../../middleware/rateLimit.middleware';

const router = Router();

// Capture the raw request body (Buffer) so the HMAC signature can be verified
// against the exact bytes Razorpay signed. A 1MB cap guards against abuse.
router.post(
  '/razorpay',
  webhookRateLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  webhooksController.razorpayWebhook
);

export default router;
