import { Router } from 'express';
import healthRoutes from '../modules/health/health.routes';
import authRoutes from '../modules/auth/auth.routes';
import usersRoutes from '../modules/users/users.routes';
import uploadRoutes from '../modules/upload/upload.routes';
import jobsRoutes from '../modules/jobs/jobs.routes';
import billingRoutes from '../modules/billing/billing.routes';
import webhookRoutes from '../modules/webhooks/webhooks.routes';

const router = Router();

// Mount modules
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/upload', uploadRoutes);
router.use('/jobs', jobsRoutes);
router.use('/billing', billingRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
