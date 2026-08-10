import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { diagramsController } from './diagrams.controller';
import { sharedTokenSchema, sharedUpdateSchema } from './diagrams.types';

/**
 * PUBLIC diagram share routes — mounted at /api/diagrams/shared.
 * No auth: the share token is the credential.
 */
const router = Router();

router.get(
  '/:token',
  validate(sharedTokenSchema as any),
  diagramsController.getShared
);
router.patch(
  '/:token',
  validate(sharedUpdateSchema as any),
  diagramsController.updateShared
);

export default router;
