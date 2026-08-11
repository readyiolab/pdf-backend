import { Router } from 'express';
import {
  authMiddleware,
  requireFullAccount,
  requireVerifiedEmail,
} from '../../middleware/auth.middleware';
import { requireOrgRole } from '../../middleware/org.middleware';
import { validate } from '../../middleware/validate.middleware';
import { aiRateLimiter } from '../../middleware/rateLimit.middleware';
import { diagramsController } from './diagrams.controller';
import {
  createDiagramSchema,
  updateDiagramSchema,
  diagramIdSchema,
  restoreVersionSchema,
  listDiagramsSchema,
  createFolderSchema,
  updateFolderSchema,
  folderIdSchema,
  createShareSchema,
  shareIdSchema,
  aiGenerateSchema,
  aiEditSchema,
  aiFromImageSchema,
  aiAnalyzeSchema,
  aiExplainSchema,
  aiExplainSelectionSchema,
  aiDiffSummarySchema,
} from './diagrams.types';

const router = Router();

router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

const member = requireOrgRole(['OWNER', 'ADMIN', 'HR_MANAGER', 'VIEWER']);
const editor = requireOrgRole(['OWNER', 'ADMIN', 'HR_MANAGER']);

// Static paths before /:id
router.get('/folders', member, diagramsController.listFolders);
router.post(
  '/folders',
  editor,
  validate(createFolderSchema as any),
  diagramsController.createFolder
);
router.patch(
  '/folders/:id',
  editor,
  validate(updateFolderSchema as any),
  diagramsController.renameFolder
);
router.delete(
  '/folders/:id',
  editor,
  validate(folderIdSchema as any),
  diagramsController.deleteFolder
);

router.post(
  '/ai/generate',
  editor,
  aiRateLimiter,
  validate(aiGenerateSchema as any),
  diagramsController.aiGenerate
);
router.post(
  '/ai/from-image',
  editor,
  aiRateLimiter,
  validate(aiFromImageSchema as any),
  diagramsController.aiFromImage
);

router.delete(
  '/share/:shareId',
  editor,
  validate(shareIdSchema as any),
  diagramsController.revokeShare
);

router.get(
  '/',
  member,
  validate(listDiagramsSchema as any),
  diagramsController.list
);
router.post(
  '/',
  editor,
  validate(createDiagramSchema as any),
  diagramsController.create
);

router.get(
  '/:id',
  member,
  validate(diagramIdSchema as any),
  diagramsController.get
);
router.patch(
  '/:id',
  editor,
  validate(updateDiagramSchema as any),
  diagramsController.update
);
router.post(
  '/:id/duplicate',
  editor,
  validate(diagramIdSchema as any),
  diagramsController.duplicate
);
router.delete(
  '/:id',
  editor,
  validate(diagramIdSchema as any),
  diagramsController.remove
);

router.get(
  '/:id/versions',
  member,
  validate(diagramIdSchema as any),
  diagramsController.listVersions
);
router.post(
  '/:id/restore/:version',
  editor,
  validate(restoreVersionSchema as any),
  diagramsController.restoreVersion
);

router.post(
  '/:id/share',
  editor,
  validate(createShareSchema as any),
  diagramsController.createShare
);
router.get(
  '/:id/shares',
  member,
  validate(diagramIdSchema as any),
  diagramsController.listShares
);

router.post(
  '/:id/ai/edit',
  editor,
  aiRateLimiter,
  validate(aiEditSchema as any),
  diagramsController.aiEdit
);

router.post(
  '/:id/ai/analyze',
  editor,
  aiRateLimiter,
  validate(aiAnalyzeSchema as any),
  diagramsController.aiAnalyze
);
router.post(
  '/:id/ai/explain',
  editor,
  aiRateLimiter,
  validate(aiExplainSchema as any),
  diagramsController.aiExplain
);
router.post(
  '/:id/ai/explain-selection',
  editor,
  aiRateLimiter,
  validate(aiExplainSelectionSchema as any),
  diagramsController.aiExplainSelection
);
router.post(
  '/:id/ai/diff-summary',
  editor,
  aiRateLimiter,
  validate(aiDiffSummarySchema as any),
  diagramsController.aiDiffSummary
);

export default router;
