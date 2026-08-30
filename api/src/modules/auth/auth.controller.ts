import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { revokeToken, signRefreshToken, verifyToken, REFRESH_JWT_AUDIENCE, isTokenRevoked } from '../../lib/jwt';
import { AppError } from '../../middleware/errorHandler.middleware';
import type { AuthResponse } from './auth.types';
import {
  setSessionCookies,
  clearSessionCookies,
  authResponseBody,
  REFRESH_COOKIE,
} from '../../lib/sessionCookies';

function issueSession(res: Response, result: AuthResponse, status = 200) {
  const refreshToken = signRefreshToken({
    userId: result.user.id,
    email: result.user.email,
    plan: result.user.plan,
    isGuest: result.user.isGuest,
  });
  setSessionCookies(res, result.token, refreshToken);
  res.status(status).json(authResponseBody(result.user));
}

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body);
      issueSession(res, result, 201);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body);
      issueSession(res, result);
    } catch (err) {
      next(err);
    }
  },

  async guest(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.guest(req.body?.attribution);
      issueSession(res, result, 201);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.tokenJti && req.tokenExp) {
        await revokeToken(req.tokenJti, req.tokenExp);
      }
      const refreshToken = req.cookies?.[REFRESH_COOKIE];
      if (refreshToken) {
        try {
          const decoded = verifyToken(refreshToken, { audience: REFRESH_JWT_AUDIENCE });
          if (decoded.jti && decoded.exp) {
            await revokeToken(decoded.jti, decoded.exp);
          }
        } catch {
          /* ignore invalid refresh token on logout */
        }
      }
      clearSessionCookies(res);
      res.status(200).json({ status: 'success', message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.cookies?.[REFRESH_COOKIE];
      if (!refreshToken) {
        throw new AppError('Refresh token missing', 401);
      }

      let decoded;
      try {
        decoded = verifyToken(refreshToken, { audience: REFRESH_JWT_AUDIENCE });
      } catch {
        clearSessionCookies(res);
        throw new AppError('Invalid or expired refresh token', 401);
      }

      if (decoded.jti && (await isTokenRevoked(decoded.jti))) {
        clearSessionCookies(res);
        throw new AppError('Refresh token revoked', 401);
      }

      const result = await authService.refreshSession(decoded.userId);
      if (decoded.jti && decoded.exp) {
        await revokeToken(decoded.jti, decoded.exp);
      }
      issueSession(res, result);
    } catch (err) {
      next(err);
    }
  },

  async google(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.googleAuth(req.body);
      issueSession(res, result);
    } catch (err) {
      next(err);
    }
  },

  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.verifyEmail(req.body.token);
      issueSession(res, result);
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
