import { getPool } from '../../lib/mysql';
import { razorpay } from '../../lib/razorpay';
import { AppError } from '../../middleware/errorHandler.middleware';
import { CheckoutInput } from './billing.types';
import crypto from 'crypto';

export const billingService = {
  async createCheckout(userId: string, input: CheckoutInput) {
    if (!razorpay) {
      throw new AppError('Billing service is currently unavailable. Please contact support.', 503);
    }

    const { planId } = input;
    const pool = getPool();

    try {
      // 1. Create Subscription on Razorpay
      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        total_count: 60, // 5 years subscription limit
        quantity: 1,
        customer_notify: 1,
        notes: {
          userId: userId,
        },
      });

      // 2. Record/Update subscription locally in DB -> tbl_subscription
      const [existingSubs]: any = await pool.query('SELECT * FROM tbl_subscription WHERE userId = ?', [userId]);
      
      if (existingSubs.length > 0) {
        await pool.query(
          'UPDATE tbl_subscription SET razorpaySubId = ?, status = ? WHERE userId = ?',
          [subscription.id, subscription.status, userId]
        );
      } else {
        const subId = crypto.randomUUID();
        await pool.query(
          'INSERT INTO tbl_subscription (id, userId, razorpaySubId, status) VALUES (?, ?, ?, ?)',
          [subId, userId, subscription.id, subscription.status]
        );
      }

      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        razorpayKey: razorpay.key_id,
      };
    } catch (err: any) {
      throw new AppError(`Razorpay subscription creation failed: ${err.message}`, 500);
    }
  },

  async getSubscriptionStatus(userId: string) {
    const pool = getPool();
    const [subs]: any = await pool.query('SELECT * FROM tbl_subscription WHERE userId = ?', [userId]);
    const subscription = subs[0];

    if (!subscription) {
      return { plan: 'FREE', status: 'none' };
    }

    return {
      subscriptionId: subscription.razorpaySubId,
      status: subscription.status,
    };
  },
};
