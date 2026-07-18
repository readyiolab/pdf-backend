import { Request, Response, NextFunction } from 'express';
import { publicSigningService } from './public.service';
import { verifySigningSession } from '../../lib/signingSession';

/**
 * Reads the optional signing session from the Authorization header.
 *
 * Returns null rather than throwing on a bad token: whether a session is
 * REQUIRED depends on the recipient's authMethod, which only the service knows.
 * Rejecting here would break signers who need no verification at all.
 */
function readSession(req: Request): { recipientId: string; documentId: string } | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const claims = verifySigningSession(header.slice(7));
    return { recipientId: claims.recipientId, documentId: claims.documentId };
  } catch {
    return null;
  }
}

export const publicSigningController = {
  async getSigningView(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await publicSigningService.getSigningView(req.params.token, req));
    } catch (err) {
      next(err);
    }
  },

  async requestOtp(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await publicSigningService.requestOtp(req.params.token, req));
    } catch (err) {
      next(err);
    }
  },

  async verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await publicSigningService.verifyOtp(req.params.token, req.body.code, req));
    } catch (err) {
      next(err);
    }
  },

  async complete(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await publicSigningService.complete(
        req.params.token,
        req.body.values,
        readSession(req),
        req
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async decline(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await publicSigningService.decline(req.params.token, req.body.reason, req));
    } catch (err) {
      next(err);
    }
  },
};
