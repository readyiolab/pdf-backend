import { Router } from 'express';
import { trackingController } from './tracking.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { visitSchema, profileUpdateSchema } from './tracking.types';

const router = Router();

/** Public (optional auth): records anonymous or stitched visit. */
router.post('/visit', validate(visitSchema), trackingController.visit);

router.get('/profile', authMiddleware, trackingController.getProfile);
router.patch(
  '/profile',
  authMiddleware,
  validate(profileUpdateSchema),
  trackingController.updateProfile
);

export default router;
