import { Router } from 'express';
import { jobsController } from './jobs.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { pollRateLimiter } from '../../middleware/rateLimit.middleware';
import { createJobSchema } from './jobs.types';

const router = Router();

router.post('/', authMiddleware, validate(createJobSchema), jobsController.createJob);
// Live progress via Server-Sent Events (authenticates via query token internally).
router.get('/:jobId/stream', jobsController.streamJob);
// Status polling gets its own higher-frequency limiter (fallback for SSE).
router.get('/:jobId', authMiddleware, pollRateLimiter, jobsController.getJob);
router.get('/:jobId/download', authMiddleware, jobsController.downloadJob);

export default router;
