import { Router } from 'express';
import { publicSigningController } from './public.controller';
import { signingRateLimiter, otpRateLimiter } from '../../middleware/rateLimit.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  completeSchema,
  declineSchema,
  signTokenParamSchema,
  verifyOtpSchema,
} from './public.types';

/**
 * PUBLIC signing routes — mounted at /api/sign.
 *
 * There is deliberately NO authMiddleware here: the entire point is that a
 * recipient signs without an account. The signing token in the URL is the
 * credential, and every handler resolves it through
 * `publicSigningService.resolveToken`, which is the only authorisation
 * boundary these routes have. Do not add a route to this file that skips it.
 */
const router = Router();

// Applies to every route below, including the OTP ones (which stack their own
// tighter limit on top).
router.use(signingRateLimiter);

router.get('/:token', validate(signTokenParamSchema), publicSigningController.getSigningView);

router.post('/:token/otp', otpRateLimiter, validate(signTokenParamSchema), publicSigningController.requestOtp);
router.post('/:token/verify-otp', otpRateLimiter, validate(verifyOtpSchema), publicSigningController.verifyOtp);

router.post('/:token/complete', validate(completeSchema), publicSigningController.complete);
router.post('/:token/decline', validate(declineSchema), publicSigningController.decline);

export default router;
