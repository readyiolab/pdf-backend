import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { invalidateUser } from '../../lib/userCache';
import { AppError } from '../../middleware/errorHandler.middleware';

export const webhooksService = {
  async handleRazorpayWebhook(rawBody: string, signature: string) {
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('Razorpay Webhook secret is not configured');
      throw new AppError('Webhook secret is not configured', 503);
    }

    // 1. Verify webhook signature (constant-time comparison to avoid timing leaks)
    const computedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(computedSignature, 'utf8');
    const received = Buffer.from(signature, 'utf8');
    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      logger.error('Invalid Razorpay Webhook signature');
      throw new AppError('Invalid webhook signature', 400);
    }

    // 2. Parse payload
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new AppError('Invalid JSON payload', 400);
    }

    const eventName = event.event;
    const eventId = String(event.id || event.event_id || '').trim();
    if (!eventId) {
      throw new AppError('Webhook event id missing', 400);
    }

    // 3. Idempotency — Razorpay may retry; ignore duplicates
    try {
      await db.insert('tbl_webhook_event', {
        id: crypto.randomUUID(),
        provider: 'razorpay',
        eventId,
        eventName: eventName || null,
      });
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') {
        logger.info({ eventId, eventName }, 'Duplicate Razorpay webhook ignored');
        return { success: true, message: 'Duplicate event ignored' };
      }
      throw err;
    }

    const subscriptionData = event.payload?.subscription?.entity;

    if (!subscriptionData) {
      logger.info({ eventName }, 'Received unhandled Razorpay event type or empty entity');
      return { success: true, message: 'Event ignored' };
    }

    const subId = subscriptionData.id;
    const subStatus = subscriptionData.status;
    const currentEndEpoch = subscriptionData.current_end; // unix timestamp

    logger.info({ eventName, subId, subStatus, eventId }, 'Processing Razorpay webhook');

    // 4. Process events
    switch (eventName) {
      case 'subscription.activated':
      case 'subscription.charged': {
        const dbSub = await db.select('tbl_subscription', '*', 'razorpaySubId = ?', [subId]);

        if (dbSub) {
          const conn = await db.beginTransaction();
          try {
            const currentPeriodEnd = currentEndEpoch ? new Date(currentEndEpoch * 1000) : null;

            await conn.query(
              'UPDATE tbl_subscription SET status = ?, currentPeriodEnd = ? WHERE id = ?',
              ['active', currentPeriodEnd, dbSub.id]
            );
            await conn.query('UPDATE tbl_user SET plan = ? WHERE id = ?', ['PRO', dbSub.userId]);

            await db.commit(conn);
            await invalidateUser(dbSub.userId);
            logger.info({ userId: dbSub.userId }, 'User upgraded to PRO plan via webhook');
          } catch (err) {
            await db.rollback(conn);
            logger.error({ err, subId }, 'Transaction failed for subscription activation');
            throw err;
          }
        } else {
          logger.warn({ subId }, 'Subscription record not found in DB for activation');
        }
        break;
      }

      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed': {
        const dbSub = await db.select('tbl_subscription', '*', 'razorpaySubId = ?', [subId]);

        if (dbSub) {
          const conn = await db.beginTransaction();
          try {
            const currentPeriodEnd = currentEndEpoch ? new Date(currentEndEpoch * 1000) : null;

            await conn.query(
              'UPDATE tbl_subscription SET status = ?, currentPeriodEnd = ? WHERE id = ?',
              [subStatus, currentPeriodEnd, dbSub.id]
            );
            await conn.query('UPDATE tbl_user SET plan = ? WHERE id = ?', ['FREE', dbSub.userId]);

            await db.commit(conn);
            await invalidateUser(dbSub.userId);
            logger.info({ userId: dbSub.userId }, 'User downgraded to FREE plan via webhook');
          } catch (err) {
            await db.rollback(conn);
            logger.error({ err, subId }, 'Transaction failed for subscription cancellation');
            throw err;
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
