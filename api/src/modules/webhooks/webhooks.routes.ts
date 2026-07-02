import { Router } from 'express';
import { webhooksController } from './webhooks.controller';

const router = Router();

router.post('/razorpay', webhooksController.razorpayWebhook);

export default router;
