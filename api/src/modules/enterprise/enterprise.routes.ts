import { Router } from 'express';
import { authMiddleware, requireFullAccount } from '../../middleware/auth.middleware';
import { enterpriseStorageLimiter } from '../../middleware/rateLimit.middleware';
import { enterpriseController } from './enterprise.controller';

const router = Router();

router.use(authMiddleware, requireFullAccount);

router.get('/organization', enterpriseController.getOrganization);
router.post('/organization', enterpriseController.getOrganization);

router.get('/storage', enterpriseController.getStorage);
router.put('/storage', enterpriseStorageLimiter, enterpriseController.saveStorage);
router.post('/storage/test', enterpriseStorageLimiter, enterpriseController.testStorage);
router.delete('/storage', enterpriseController.resetStorage);

router.get('/audit', enterpriseController.listAudit);

export default router;
