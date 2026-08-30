import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '../../middleware/validate.middleware';
import { authRateLimiter } from '../../middleware/rateLimit.middleware';
import { authMiddleware } from '../../middleware/auth.middleware';
import {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  googleAuthSchema,
} from './auth.types';

const router = Router();

router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
router.post('/google', authRateLimiter, validate(googleAuthSchema), authController.google);
router.post('/guest', authRateLimiter, authController.guest);
router.post('/refresh', authRateLimiter, authController.refresh);
router.post('/logout', authMiddleware, authController.logout);
router.post('/verify-email', authRateLimiter, validate(verifyEmailSchema), authController.verifyEmail);
router.post('/resend-verification', authRateLimiter, authMiddleware, authController.resendVerification);

export default router;
