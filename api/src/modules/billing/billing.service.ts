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

    // Reserve / lock a local subscription row BEFORE calling Razorpay so concurrent
    // checkouts for the same user cannot create multiple remote subscriptions.
    const existingSub = await db.select('tbl_subscription', '*', 'userId = ?', [userId]);
    let localId = existingSub?.id as string | undefined;

    if (existingSub) {
      if (
        existingSub.status === 'created' ||
        existingSub.status === 'authenticated' ||
        existingSub.status === 'active'
      ) {
        if (existingSub.razorpaySubId) {
          return {
            subscriptionId: existingSub.razorpaySubId,
            status: existingSub.status,
            razorpayKey: env.RAZORPAY_KEY_ID || '',
          };
        }
      }
      await db.update(
        'tbl_subscription',
        { status: 'checkout_pending' },
        'userId = ?',
        [userId]
      );
    } else {
      localId = crypto.randomUUID();
      try {
        await db.insert('tbl_subscription', {
          id: localId,
          userId,
          razorpaySubId: null,
          status: 'checkout_pending',
        });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
          const raced = await db.select('tbl_subscription', '*', 'userId = ?', [userId]);
          if (raced?.razorpaySubId) {
            return {
              subscriptionId: raced.razorpaySubId,
              status: raced.status,
              razorpayKey: env.RAZORPAY_KEY_ID || '',
            };
          }
          localId = raced?.id;
        } else {
          throw err;
        }
      }
    }

    try {
      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        total_count: 60, // 5 years subscription limit
        quantity: 1,
        customer_notify: 1,
        notes: {
          userId: userId,
        },
      });

      await db.update(
        'tbl_subscription',
        { razorpaySubId: subscription.id, status: subscription.status },
        'userId = ?',
        [userId]
      );

      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        razorpayKey: env.RAZORPAY_KEY_ID || '',
      };
    } catch (err: any) {
      await db
        .update('tbl_subscription', { status: 'checkout_failed' }, 'userId = ?', [userId])
        .catch(() => undefined);
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
