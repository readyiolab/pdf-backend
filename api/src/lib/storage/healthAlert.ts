/**
 * Notify org owners when BYOC storage flips CONNECTED → ERROR.
 * Worker publishes on Redis; API (which has SMTP) sends the email.
 */
import { redis } from '../redis';
import { db } from '../mysql';
import { env } from '../../config/env';
import { isMailerConfigured, sendMail } from '../mailer';
import { logger } from '../logger';

export const BYOC_HEALTH_ALERT_CHANNEL = 'byoc:storage-health-alert';

export interface ByocHealthAlert {
  organizationId: string;
  error?: string | null;
  orgName?: string | null;
  ownerEmail?: string | null;
}

let started = false;

export async function publishByocHealthAlert(alert: ByocHealthAlert): Promise<void> {
  await redis
    .publish(BYOC_HEALTH_ALERT_CHANNEL, JSON.stringify(alert))
    .catch((err) => logger.warn({ err }, 'Failed to publish BYOC health alert'));
}

async function sendOwnerAlert(alert: ByocHealthAlert): Promise<void> {
  let ownerEmail = alert.ownerEmail;
  let orgName = alert.orgName;

  if (!ownerEmail) {
    const rows = await db.queryAll(
      `SELECT o.name AS orgName, u.email AS ownerEmail
         FROM tbl_organization o
         JOIN tbl_user u ON u.id = o.ownerUserId
        WHERE o.id = ?
        LIMIT 1`,
      [alert.organizationId]
    );
    const row = rows[0] as any;
    ownerEmail = row?.ownerEmail ?? null;
    orgName = orgName || row?.orgName || null;
  }

  if (!ownerEmail || !isMailerConfigured()) {
    logger.warn(
      { organizationId: alert.organizationId, ownerEmail, hasSmtp: isMailerConfigured() },
      'BYOC health alert could not email owner'
    );
    return;
  }

  const settingsUrl = `${env.APP_URL.replace(/\/$/, '')}/settings/cloud`;
  const subject = `[Zuvigo] Cloud storage error for ${orgName || 'your organization'}`;
  const text = [
    `Your connected cloud storage reported an error and is temporarily unavailable for new uploads.`,
    '',
    `Error: ${alert.error || 'unknown'}`,
    '',
    `Fix credentials / CORS at: ${settingsUrl}`,
    '',
    `Existing signed documents remain accessible to recipients when possible.`,
  ].join('\n');

  const html = `
    <p>Your connected cloud storage reported an error and is temporarily unavailable for new uploads.</p>
    <p><strong>Error:</strong> ${escapeHtml(alert.error || 'unknown')}</p>
    <p><a href="${settingsUrl}">Open Cloud storage settings</a> to fix credentials or CORS.</p>
    <p>Existing signed documents remain accessible to recipients when possible.</p>
  `;

  try {
    await sendMail({ to: ownerEmail, subject, text, html });
    logger.info({ organizationId: alert.organizationId, ownerEmail }, 'BYOC health alert emailed');
  } catch (err) {
    logger.warn({ err, organizationId: alert.organizationId }, 'BYOC health alert email failed');
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Call once at API boot. */
export function startByocHealthAlertSubscriber(): void {
  if (started) return;
  started = true;
  try {
    const sub = redis.duplicate();
    void sub.subscribe(BYOC_HEALTH_ALERT_CHANNEL);
    sub.on('message', (_ch, message) => {
      void (async () => {
        try {
          const alert = JSON.parse(message) as ByocHealthAlert;
          if (!alert?.organizationId) return;
          await sendOwnerAlert(alert);
        } catch (err) {
          logger.warn({ err }, 'BYOC health alert handler failed');
        }
      })();
    });
    logger.info('BYOC health alert subscriber started');
  } catch (err) {
    logger.warn({ err }, 'BYOC health alert subscriber unavailable');
  }
}
