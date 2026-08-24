import { Request, Response, NextFunction } from 'express';
import { trackingService } from './tracking.service';

function clientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || null;
}

export const trackingController = {
  async visit(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id || null;
      const result = await trackingService.trackVisit(req.body, {
        userId,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ profile: await trackingService.getProfile(req.user.id) });
    } catch (err) {
      next(err);
    }
  },

  async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const profile = await trackingService.updateProfile(req.user.id, req.body);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
};
