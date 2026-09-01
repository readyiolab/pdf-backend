import { Router } from 'express';
import { signingController } from './signing.controller';
import { authMiddleware, requireFullAccount, requireVerifiedEmail } from '../../middleware/auth.middleware';
import { designerRateLimiter } from '../../middleware/rateLimit.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  addRecipientSchema,
  auditQuerySchema,
  createDocumentSchema,
  createTemplateSchema,
  documentIdSchema,
  documentVersionSchema,
  listDocumentsSchema,
  presignDocumentSchema,
  recipientIdSchema,
  saveFieldsSchema,
  templateIdSchema,
  updateDocumentSchema,
  updateRecipientSchema,
  useTemplateSchema,
} from './signing.types';

const router = Router();

// Every signing route requires a real (non-guest) account. Applied at the
// router level so a new route can't accidentally be added without it.
router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

// --- Documents ---
router.post('/presign', validate(presignDocumentSchema), signingController.presignUpload);
router.post('/', validate(createDocumentSchema), signingController.createDocument);
router.get('/', validate(listDocumentsSchema), signingController.listDocuments);
router.get('/stats', signingController.getStats);

// --- Templates (before /:id so "templates" is not parsed as a document id) ---
router.get('/templates', signingController.listTemplates);
router.post('/templates', validate(createTemplateSchema), signingController.createTemplate);
router.delete('/templates/:id', validate(templateIdSchema), signingController.deleteTemplate);
router.post('/templates/:id/use', validate(useTemplateSchema), signingController.useTemplate);

// NOTE: /stats is declared before /:id so Express doesn't match "stats" as a
// document id (the uuid validator would then reject it with a confusing 400).
router.get('/:id', validate(documentIdSchema), signingController.getDocument);
// documentVersionSchema, not documentIdSchema — this handler reads ?version.
router.get('/:id/file', validate(documentVersionSchema), signingController.getViewUrl);
router.patch('/:id', validate(updateDocumentSchema), signingController.updateDocument);
router.delete('/:id', validate(documentIdSchema), signingController.deleteDocument);

// --- Recipients ---
router.post('/:id/recipients', validate(addRecipientSchema), signingController.addRecipient);
router.patch('/:id/recipients/:recipientId', validate(updateRecipientSchema), signingController.updateRecipient);
router.delete('/:id/recipients/:recipientId', validate(recipientIdSchema), signingController.removeRecipient);

// --- Fields ---
// Bulk replace, hit repeatedly by the designer's autosave — hence its own limiter.
router.put('/:id/fields', designerRateLimiter, validate(saveFieldsSchema), signingController.saveFields);

// --- Sending ---
router.post('/:id/send', validate(documentIdSchema), signingController.send);
router.post('/:id/send-self', validate(documentIdSchema), signingController.sendSelf);
router.post('/:id/void', validate(documentIdSchema), signingController.voidDocument);
router.post('/:id/recipients/:recipientId/resend', validate(recipientIdSchema), signingController.resend);

// --- Tracking ---
router.get('/:id/status', validate(documentIdSchema), signingController.getStatus);

// --- Output ---
router.get('/:id/download', validate(documentVersionSchema), signingController.getDownloadUrl);
router.get('/:id/download-source', validate(documentIdSchema), signingController.getSourceDownloadUrl);
router.get('/:id/certificate', validate(documentIdSchema), signingController.getCertificateUrl);

// --- Audit ---
router.get('/:id/audit', validate(auditQuerySchema), signingController.getAudit);

export default router;
