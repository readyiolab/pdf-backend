import { Router } from 'express';
import { billingController } from './billing.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { checkoutSchema } from './billing.types';

const router = Router();

router.post('/checkout', authMiddleware, validate(checkoutSchema), billingController.checkout);
router.get('/status', authMiddleware, billingController.getStatus);

export default router;
