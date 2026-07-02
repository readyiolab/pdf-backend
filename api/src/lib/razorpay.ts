import Razorpay from 'razorpay';
import { env } from '../config/env';
import { logger } from './logger';

export const razorpay =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
      })
    : null;

if (!razorpay) {
  logger.warn('Razorpay credentials missing. Billing checkout endpoints will fail until configured.');
}
