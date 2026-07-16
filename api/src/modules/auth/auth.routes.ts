import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '../../middleware/validate.middleware';
import { authRateLimiter } from '../../middleware/rateLimit.middleware';
import { authMiddleware } from '../../middleware/auth.middleware';
import { registerSchema, loginSchema } from './auth.types';

const router = Router();

router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
router.post('/guest', authRateLimiter, authController.guest);
router.post('/logout', authMiddleware, authController.logout);

export default router;
