import crypto from 'crypto';
import { db } from './mysql';
import { env } from '../config/env';
import { logger } from './logger';

export type AcquisitionChannel =
  | 'organic'
  | 'paid_search'
  | 'paid_social'
  | 'referral'
  | 'direct'
  | 'email'
  | 'unknown';

export type CustomerEventType =
  | 'visit'
  | 'signup'
  | 'login'
  | 'job_completed'
  | 'checkout_started'
  | 'subscription_active'
  | 'letter_sent'
  | 'esign_sent'
  | 'esign_completed';

export interface AttributionPayload {
  visitorId?: string | null;
  landingPath?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
}

function trim(v: unknown, max = 255): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

export function normalizeAttribution(input: AttributionPayload = {}): Required<{
  [K in keyof AttributionPayload]: string | null;
}> {
  return {
    visitorId: trim(input.visitorId, 64),
    landingPath: trim(input.landingPath, 512),
    referrer: trim(input.referrer, 1024),
    utmSource: trim(input.utmSource)?.toLowerCase() ?? null,
    utmMedium: trim(input.utmMedium)?.toLowerCase() ?? null,
    utmCampaign: trim(input.utmCampaign),
    utmTerm: trim(input.utmTerm),
    utmContent: trim(input.utmContent),
    gclid: trim(input.gclid),
    fbclid: trim(input.fbclid),
    msclkid: trim(input.msclkid),
  };
}

export function deriveAcquisitionChannel(a: AttributionPayload): AcquisitionChannel {
  const medium = (a.utmMedium || '').toLowerCase();
  const source = (a.utmSource || '').toLowerCase();
  if (a.gclid || medium === 'cpc' || medium === 'ppc' || medium === 'paidsearch') {
    return 'paid_search';
  }
  if (
    a.fbclid ||
    medium === 'paid_social' ||
    medium === 'paidsocial' ||
    medium === 'social' ||
    source === 'facebook' ||
    source === 'instagram' ||
    source === 'meta'
  ) {
    return 'paid_social';
  }
  if (medium === 'email' || source === 'email' || source === 'newsletter') return 'email';
  if (medium === 'organic' || source === 'google' || source === 'bing') return 'organic';
  if (a.utmSource || a.referrer) return a.utmSource ? 'referral' : 'referral';
  if (!a.referrer && !a.utmSource && !a.gclid && !a.fbclid) return 'direct';
  return 'unknown';
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const cleaned = ip.split(',')[0]?.trim();
  if (!cleaned) return null;
  return crypto.createHash('sha256').update(`${env.JWT_SECRET}:${cleaned}`).digest('hex');
}

export async function recordVisit(opts: {
  attribution: AttributionPayload;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string> {
  const a = normalizeAttribution(opts.attribution);
  const visitorId = a.visitorId || crypto.randomUUID();
  const id = crypto.randomUUID();
  await db.insert('tbl_marketing_visit', {
    id,
    visitorId,
    userId: opts.userId || null,
    landingPath: a.landingPath,
    referrer: a.referrer,
    utmSource: a.utmSource,
    utmMedium: a.utmMedium,
    utmCampaign: a.utmCampaign,
    utmTerm: a.utmTerm,
    utmContent: a.utmContent,
    gclid: a.gclid,
    fbclid: a.fbclid,
    msclkid: a.msclkid,
    ipHash: hashIp(opts.ip),
    userAgent: trim(opts.userAgent, 512),
  });
  return visitorId;
}

export async function recordCustomerEvent(opts: {
  type: CustomerEventType;
  userId?: string | null;
  contactId?: string | null;
  visitorId?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert('tbl_customer_event', {
      id: crypto.randomUUID(),
      userId: opts.userId || null,
      contactId: opts.contactId || null,
      visitorId: opts.visitorId ? trim(opts.visitorId, 64) : null,
      type: opts.type,
      metaJson: opts.meta ? JSON.stringify(opts.meta) : null,
    });
  } catch (err) {
    logger.warn({ err, type: opts.type }, 'Failed to record customer event');
  }
}

export async function upsertContact(opts: {
  email: string;
  name?: string | null;
  userId?: string | null;
  source?: string | null;
}): Promise<string | null> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !email.includes('@') || email.endsWith('@guest.local')) return null;

  const existing = await db.select('tbl_contact', 'id, isRepeat', 'email = ?', [email]);
  const now = new Date();
  if (existing) {
    await db.update(
      'tbl_contact',
      {
        lastSeenAt: now,
        isRepeat: 1,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
      },
      'id = ?',
      [existing.id]
    );
    return existing.id as string;
  }

  const id = crypto.randomUUID();
  await db.insert('tbl_contact', {
    id,
    email,
    name: opts.name || null,
    userId: opts.userId || null,
    firstSeenAt: now,
    lastSeenAt: now,
    isRepeat: 0,
    source: opts.source || null,
  });
  return id;
}

/**
 * Stitch visitor attribution onto a user on signup/login.
 * First-touch fields are set once; last-touch always updates.
 */
export async function stitchUserAttribution(opts: {
  userId: string;
  email?: string | null;
  name?: string | null;
  attribution?: AttributionPayload | null;
  eventType: 'signup' | 'login';
}): Promise<void> {
  try {
    const a = normalizeAttribution(opts.attribution || {});
    const now = new Date();
    const channel = deriveAcquisitionChannel(a);
    const existing = await db.select('tbl_user_attribution', '*', 'userId = ?', [opts.userId]);

    if (!existing) {
      await db.insert('tbl_user_attribution', {
        userId: opts.userId,
        visitorId: a.visitorId,
        acquisitionChannel: channel,
        firstUtmSource: a.utmSource,
        firstUtmMedium: a.utmMedium,
        firstUtmCampaign: a.utmCampaign,
        firstUtmTerm: a.utmTerm,
        firstUtmContent: a.utmContent,
        firstGclid: a.gclid,
        firstFbclid: a.fbclid,
        firstMsclkid: a.msclkid,
        firstReferrer: a.referrer,
        firstLandingPath: a.landingPath,
        lastUtmSource: a.utmSource,
        lastUtmMedium: a.utmMedium,
        lastUtmCampaign: a.utmCampaign,
        lastUtmTerm: a.utmTerm,
        lastUtmContent: a.utmContent,
        lastGclid: a.gclid,
        lastFbclid: a.fbclid,
        lastMsclkid: a.msclkid,
        lastReferrer: a.referrer,
        lastLandingPath: a.landingPath,
        firstVisitAt: now,
        signupAt: opts.eventType === 'signup' ? now : now,
        lastSeenAt: now,
        lastLoginAt: opts.eventType === 'login' ? now : null,
      });
    } else {
      const patch: Record<string, unknown> = {
        lastSeenAt: now,
        lastUtmSource: a.utmSource ?? existing.lastUtmSource,
        lastUtmMedium: a.utmMedium ?? existing.lastUtmMedium,
        lastUtmCampaign: a.utmCampaign ?? existing.lastUtmCampaign,
        lastUtmTerm: a.utmTerm ?? existing.lastUtmTerm,
        lastUtmContent: a.utmContent ?? existing.lastUtmContent,
        lastGclid: a.gclid ?? existing.lastGclid,
        lastFbclid: a.fbclid ?? existing.lastFbclid,
        lastMsclkid: a.msclkid ?? existing.lastMsclkid,
        lastReferrer: a.referrer ?? existing.lastReferrer,
        lastLandingPath: a.landingPath ?? existing.lastLandingPath,
      };
      if (a.visitorId) patch.visitorId = a.visitorId;
      if (opts.eventType === 'login') patch.lastLoginAt = now;
      if (opts.eventType === 'signup' && !existing.signupAt) patch.signupAt = now;
      await db.update('tbl_user_attribution', patch, 'userId = ?', [opts.userId]);
    }

    if (a.visitorId) {
      await db
        .execute('UPDATE tbl_marketing_visit SET userId = ? WHERE visitorId = ? AND userId IS NULL', [
          opts.userId,
          a.visitorId,
        ])
        .catch(() => undefined);
    }

    if (opts.email) {
      await upsertContact({
        email: opts.email,
        name: opts.name,
        userId: opts.userId,
        source: channel,
      });
    }

    await recordCustomerEvent({
      type: opts.eventType,
      userId: opts.userId,
      visitorId: a.visitorId,
      meta: { channel },
    });
  } catch (err) {
    logger.warn({ err, userId: opts.userId }, 'Failed to stitch user attribution');
  }
}

export async function isRepeatUser(userId: string): Promise<boolean> {
  const rows = await db.queryAll<any>(
    `SELECT type, COUNT(*) AS cnt
       FROM tbl_customer_event
      WHERE userId = ?
        AND type IN ('login','subscription_active','job_completed','letter_sent','esign_completed')
      GROUP BY type`,
    [userId]
  );
  let logins = 0;
  let paid = 0;
  let jobs = 0;
  for (const r of rows) {
    const c = Number(r.cnt || 0);
    if (r.type === 'login') logins = c;
    if (r.type === 'subscription_active') paid = c;
    if (r.type === 'job_completed' || r.type === 'letter_sent' || r.type === 'esign_completed') {
      jobs += c;
    }
  }
  if (logins >= 2 || paid >= 1) return true;
  const days = await db.queryAll<any>(
    `SELECT COUNT(DISTINCT DATE(createdAt)) AS d
       FROM tbl_customer_event
      WHERE userId = ?
        AND type IN ('job_completed','letter_sent','esign_completed')`,
    [userId]
  );
  return Number(days[0]?.d || 0) >= 2 || jobs >= 3;
}
