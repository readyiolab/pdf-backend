import { Router } from 'express';
import { uploadController } from './upload.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { presignUploadSchema } from './upload.types';

const router = Router();

router.post('/presign', authMiddleware, validate(presignUploadSchema), uploadController.getPresignedUrl);

export default router;
