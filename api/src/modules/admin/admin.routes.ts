import { Router } from 'express';
import { adminAuthMiddleware, requireFullAccount } from '../../middleware/auth.middleware';
import { requirePlatformAdmin } from '../../middleware/platformAdmin.middleware';
import { authRateLimiter } from '../../middleware/rateLimit.middleware';
import { adminController } from './admin.controller';

const router = Router();

// Admin JWT login (no prior auth) — issues audience=platform-admin token
router.post('/login', authRateLimiter, adminController.login);

router.use(adminAuthMiddleware, requireFullAccount, requirePlatformAdmin);

router.get('/dashboard', adminController.dashboard);
router.get('/organizations', adminController.listOrganizations);
router.post('/organizations', adminController.provision);
router.get('/organizations/:id', adminController.getOrganization);
router.patch('/organizations/:id', adminController.patchOrganization);
router.get('/organizations/:id/audit', adminController.getAudit);
router.get('/customers', adminController.listCustomers);
router.get('/customers/:id', adminController.getCustomer);

export default router;
