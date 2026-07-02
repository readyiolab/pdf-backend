import { Router } from 'express';
import { jobsController } from './jobs.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { createJobSchema } from './jobs.types';

const router = Router();

router.post('/', authMiddleware, validate(createJobSchema), jobsController.createJob);
router.get('/:jobId', authMiddleware, jobsController.getJob);

export default router;
