import { Router } from 'express';
import { CloudController } from './cloud.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.get('/integrations', authMiddleware, CloudController.getIntegrations);
router.post('/connect', authMiddleware, CloudController.connect);
router.post('/disconnect', authMiddleware, CloudController.disconnect);
router.get('/files', authMiddleware, CloudController.getFiles);
router.post('/sync', authMiddleware, CloudController.sync);

export const cloudRoutes = router;
