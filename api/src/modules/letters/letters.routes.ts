import { Router } from 'express';
import { z } from 'zod';
import {
  authMiddleware,
  requireFullAccount,
  requireVerifiedEmail,
} from '../../middleware/auth.middleware';
import { requireOrgRole } from '../../middleware/org.middleware';
import { validate } from '../../middleware/validate.middleware';
import { lettersController } from './letters.controller';
import {
  brandCreateSchema,
  brandUpdateSchema,
  templateCreateSchema,
  templateUpdateSchema,
  approveGenerateSchema,
  sendBatchSchema,
  mailExchangeSchema,
} from './letters.types';
import { LETTER_TYPES } from './letterFields';

const router = Router();

router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

const member = requireOrgRole(['OWNER', 'ADMIN', 'HR_MANAGER', 'VIEWER']);
const editor = requireOrgRole(['OWNER', 'ADMIN', 'HR_MANAGER']);
const admin = requireOrgRole(['OWNER', 'ADMIN']);

router.post('/bootstrap', lettersController.bootstrap);

// Brands
router.get('/brands', member, lettersController.listBrands);
router.post('/brands', editor, validate(brandCreateSchema), lettersController.createBrand);
router.patch('/brands/:id', editor, validate(brandUpdateSchema), lettersController.updateBrand);
router.delete('/brands/:id', admin, lettersController.deleteBrand);

// Templates
router.get('/templates', member, lettersController.listTemplates);
router.post('/templates/seed', editor, lettersController.seedTemplates);
router.get('/templates/:id', member, lettersController.getTemplate);
router.post('/templates', editor, validate(templateCreateSchema), lettersController.createTemplate);
router.patch(
  '/templates/:id',
  editor,
  validate(templateUpdateSchema),
  lettersController.updateTemplate
);
router.delete('/templates/:id', admin, lettersController.deleteTemplate);

// Batches
router.get('/batches', member, lettersController.listBatches);
router.post(
  '/batches',
  editor,
  validate(
    z.object({
      body: z.object({
        templateId: z.string().min(1),
        brandProfileId: z.string().optional().nullable(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    })
  ),
  lettersController.createBatch
);
router.get('/batches/:batchId', member, lettersController.getBatch);
router.post('/batches/:batchId/parse', editor, lettersController.parseUpload);
router.post('/batches/:batchId/map', editor, lettersController.applyMapping);
router.post('/batches/:batchId/validate', editor, lettersController.validateBatch);
router.get('/batches/:batchId/issues', member, lettersController.validationIssues);
router.get('/batches/:batchId/employees', member, lettersController.listEmployees);
router.get('/batches/:batchId/preview', member, lettersController.samplePreview);
router.post(
  '/batches/:batchId/generate',
  editor,
  validate(approveGenerateSchema),
  lettersController.approveGenerate
);
router.get('/batches/:batchId/progress', member, lettersController.generateProgress);
router.post(
  '/batches/:batchId/generate/retry-failed',
  editor,
  lettersController.retryFailedGenerate
);
router.post(
  '/batches/:batchId/send',
  editor,
  validate(sendBatchSchema),
  lettersController.startSend
);
router.get('/batches/:batchId/report', member, lettersController.report);
router.post('/batches/:batchId/pdfs/zip', member, lettersController.downloadPdfsZip);
router.get(
  '/batches/:batchId/pdfs/zip/:zipJobId',
  member,
  lettersController.downloadPdfsZipStatus
);
router.get(
  '/batches/:batchId/employees/:employeeId/pdf',
  member,
  lettersController.employeePdfUrl
);

// Mail accounts (user-scoped, not org-scoped role beyond auth)
router.get('/mail/accounts', lettersController.listMailAccounts);
router.get('/mail/authorize', lettersController.mailAuthorize);
router.post('/mail/exchange', validate(mailExchangeSchema), lettersController.mailExchange);
router.delete('/mail/accounts/:id', lettersController.disconnectMailAccount);

// Audit
router.get('/audit', member, lettersController.audit);

// AI — suggestions only; never triggers generate/send
router.post(
  '/ai/draft',
  editor,
  validate(
    z.object({
      body: z.object({
        instruction: z.string().min(3).max(2000),
        letterType: z.enum(LETTER_TYPES).optional(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    })
  ),
  lettersController.aiDraft
);
router.post('/ai/apply-draft', editor, lettersController.aiApplyDraft);
router.post(
  '/ai/polish',
  editor,
  validate(
    z.object({
      body: z.object({
        text: z.string().min(1).max(10_000),
        mode: z.enum(['formal', 'concise', 'add-disclaimer']),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    })
  ),
  lettersController.aiPolish
);
router.post('/ai/suggest-mapping', editor, lettersController.aiSuggestMapping);
router.post('/batches/:batchId/ai/anomalies', editor, lettersController.aiAnomalies);
router.post('/batches/:batchId/ai/summary', editor, lettersController.aiSummary);
router.post(
  '/ai/query',
  member,
  validate(
    z.object({
      body: z.object({ question: z.string().min(3).max(500) }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    })
  ),
  lettersController.aiQuery
);
router.post(
  '/ai/suggest-template',
  editor,
  validate(
    z.object({
      body: z.object({ letterType: z.enum(LETTER_TYPES) }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    })
  ),
  lettersController.aiSuggestTemplate
);

export default router;
