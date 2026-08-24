import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { revokeToken } from '../../lib/jwt';

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async guest(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.guest(req.body?.attribution);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.tokenJti && req.tokenExp) {
        await revokeToken(req.tokenJti, req.tokenExp);
      }
      res.status(200).json({ status: 'success', message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  },

  async google(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.googleAuth(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.verifyEmail(req.body.token);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async resendVerification(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.resendVerification(req.user.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
