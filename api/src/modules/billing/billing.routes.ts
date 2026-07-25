import { Router } from 'express';
import { billingController } from './billing.controller';
import { authMiddleware, requireVerifiedEmail } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { checkoutSchema } from './billing.types';

const router = Router();

router.post('/checkout', authMiddleware, requireVerifiedEmail, validate(checkoutSchema), billingController.checkout);
router.get('/status', authMiddleware, requireVerifiedEmail, billingController.getStatus);

export default router;
