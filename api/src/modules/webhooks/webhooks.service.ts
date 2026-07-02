import crypto from 'crypto';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';

export const webhooksService = {
  async handleRazorpayWebhook(rawBody: string, signature: string) {
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.warn('Razorpay Webhook secret is not configured. Webhook request skipped verification.');
      return { success: false, message: 'Webhook secret missing' };
    }

    // 1. Verify webhook signature
    const computedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (computedSignature !== signature) {
      logger.error('Invalid Razorpay Webhook signature');
      throw new AppError('Invalid webhook signature', 400);
    }

    // 2. Parse payload
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      throw new AppError('Invalid JSON payload', 400);
    }

    const eventName = event.event;
    const subscriptionData = event.payload?.subscription?.entity;

    if (!subscriptionData) {
      logger.info({ eventName }, 'Received unhandled Razorpay event type or empty entity');
      return { success: true, message: 'Event ignored' };
    }

    const subId = subscriptionData.id;
    const subStatus = subscriptionData.status;
    const currentEndEpoch = subscriptionData.current_end; // unix timestamp
    const pool = getPool();

    logger.info({ eventName, subId, subStatus }, 'Processing Razorpay webhook');

    // 3. Process events
    switch (eventName) {
      case 'subscription.activated':
      case 'subscription.charged': {
        const [subs]: any = await pool.query('SELECT * FROM tbl_subscription WHERE razorpaySubId = ?', [subId]);
        const dbSub = subs[0];

        if (dbSub) {
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            const currentPeriodEnd = currentEndEpoch ? new Date(currentEndEpoch * 1000) : null;
            
            await conn.query(
              'UPDATE tbl_subscription SET status = ?, currentPeriodEnd = ? WHERE id = ?',
              ['active', currentPeriodEnd, dbSub.id]
            );
            await conn.query('UPDATE tbl_user SET plan = ? WHERE id = ?', ['PRO', dbSub.userId]);
            
            await conn.commit();
            logger.info({ userId: dbSub.userId }, 'User upgraded to PRO plan via webhook');
          } catch (err) {
            await conn.rollback();
            logger.error({ err, subId }, 'Transaction failed for subscription activation');
            throw err;
          } finally {
            conn.release();
          }
        } else {
          logger.warn({ subId }, 'Subscription record not found in DB for activation');
        }
        break;
      }

      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed': {
        const [subs]: any = await pool.query('SELECT * FROM tbl_subscription WHERE razorpaySubId = ?', [subId]);
        const dbSub = subs[0];

        if (dbSub) {
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            const currentPeriodEnd = currentEndEpoch ? new Date(currentEndEpoch * 1000) : null;

            await conn.query(
              'UPDATE tbl_subscription SET status = ?, currentPeriodEnd = ? WHERE id = ?',
              [subStatus, currentPeriodEnd, dbSub.id]
            );
            await conn.query('UPDATE tbl_user SET plan = ? WHERE id = ?', ['FREE', dbSub.userId]);

            await conn.commit();
            logger.info({ userId: dbSub.userId }, 'User downgraded to FREE plan via webhook');
          } catch (err) {
            await conn.rollback();
            logger.error({ err, subId }, 'Transaction failed for subscription cancellation');
            throw err;
          } finally {
            conn.release();
          }
        }
        break;
      }

      default:
        logger.info({ eventName }, 'Unhandled webhook event type');
    }

    return { success: true };
  },
};
