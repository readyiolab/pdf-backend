import { Router } from 'express';
import { uploadController } from './upload.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  presignUploadSchema,
  presignBatchSchema,
  multipartInitSchema,
  multipartPresignPartsSchema,
  multipartCompleteSchema,
  multipartAbortSchema,
} from './upload.types';

const router = Router();

router.post('/presign', authMiddleware, validate(presignUploadSchema), uploadController.getPresignedUrl);
router.post(
  '/presign-batch',
  authMiddleware,
  validate(presignBatchSchema),
  uploadController.getPresignedUrlBatch
);

router.post(
  '/multipart/init',
  authMiddleware,
  validate(multipartInitSchema),
  uploadController.initMultipart
);
router.post(
  '/multipart/presign-parts',
  authMiddleware,
  validate(multipartPresignPartsSchema),
  uploadController.presignMultipartParts
);
router.post(
  '/multipart/complete',
  authMiddleware,
  validate(multipartCompleteSchema),
  uploadController.completeMultipart
);
router.post(
  '/multipart/abort',
  authMiddleware,
  validate(multipartAbortSchema),
  uploadController.abortMultipart
);

export default router;
