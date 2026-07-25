import { db } from '../../lib/mysql';
import { razorpay } from '../../lib/razorpay';
import { AppError } from '../../middleware/errorHandler.middleware';
import { env } from '../../config/env';
import { CheckoutInput } from './billing.types';
import crypto from 'crypto';

export const billingService = {
  async createCheckout(userId: string, input: CheckoutInput) {
    if (!razorpay) {
      throw new AppError('Billing service is currently unavailable. Please contact support.', 503);
    }

    const { planId } = input;

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
      const existingSub = await db.select('tbl_subscription', '*', 'userId = ?', [userId]);

      if (existingSub) {
        await db.update(
          'tbl_subscription',
          { razorpaySubId: subscription.id, status: subscription.status },
          'userId = ?',
          [userId]
        );
      } else {
        const subId = crypto.randomUUID();
        await db.insert('tbl_subscription', {
          id: subId,
          userId,
          razorpaySubId: subscription.id,
          status: subscription.status,
        });
      }

      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        razorpayKey: env.RAZORPAY_KEY_ID || '',
      };
    } catch (err: any) {
      throw new AppError(`Razorpay subscription creation failed: ${err.message}`, 500);
    }
  },

  async getSubscriptionStatus(userId: string) {
    const subscription = await db.select('tbl_subscription', '*', 'userId = ?', [userId]);

    if (!subscription) {
      return { plan: 'FREE', status: 'none' };
    }

    return {
      subscriptionId: subscription.razorpaySubId,
      status: subscription.status,
    };
  },
};
