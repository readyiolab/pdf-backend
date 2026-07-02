import { Request, Response, NextFunction } from 'express';
import { webhooksService } from './webhooks.service';
import { logger } from '../../lib/logger';

export const webhooksController = {
  async razorpayWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      const rawBody = (req as any).rawBody;

      if (!signature) {
        res.status(400).json({ status: 'error', message: 'Signature missing' });
        return;
      }

      if (!rawBody) {
        res.status(400).json({ status: 'error', message: 'Raw body missing' });
        return;
      }

      const result = await webhooksService.handleRazorpayWebhook(rawBody, signature);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
