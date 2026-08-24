import { recordVisit, normalizeAttribution } from '../../lib/customerTracking';
import { db } from '../../lib/mysql';
import type { VisitInput, ProfileUpdateInput } from './tracking.types';

export const trackingService = {
  async trackVisit(
    input: VisitInput,
    opts: { userId?: string | null; ip?: string | null; userAgent?: string | null }
  ) {
    const visitorId = await recordVisit({
      attribution: input,
      userId: opts.userId,
      ip: opts.ip,
      userAgent: opts.userAgent,
    });
    return { visitorId, ok: true as const };
  },

  async getProfile(userId: string) {
    const row = await db.select('tbl_user_profile', '*', 'userId = ?', [userId]);
    return (
      row || {
        userId,
        phone: null,
        company: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
      }
    );
  },

  async updateProfile(userId: string, input: ProfileUpdateInput) {
    const existing = await db.select('tbl_user_profile', 'userId', 'userId = ?', [userId]);
    const patch = {
      phone: input.phone ?? null,
      company: input.company ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
    };
    if (existing) {
      await db.update('tbl_user_profile', patch, 'userId = ?', [userId]);
    } else {
      await db.insert('tbl_user_profile', { userId, ...patch });
    }
    return this.getProfile(userId);
  },

  normalize: normalizeAttribution,
};
