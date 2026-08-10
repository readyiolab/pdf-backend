import { Router } from 'express';
import { authMiddleware, requireFullAccount, requireVerifiedEmail } from '../../middleware/auth.middleware';
import { requireOrgRole, attachOrgContext } from '../../middleware/org.middleware';
import { validate } from '../../middleware/validate.middleware';
import { orgsController } from './orgs.controller';
import {
  createOrgSchema,
  inviteMemberSchema,
  acceptInviteSchema,
  changeRoleSchema,
} from './orgs.types';
import { z } from 'zod';

const router = Router();

router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

router.get('/', orgsController.listMine);
router.post('/', validate(createOrgSchema), orgsController.create);
router.post('/ensure', orgsController.ensure);
router.post('/accept-invite', validate(acceptInviteSchema), orgsController.acceptInvite);

router.get('/members', requireOrgRole(['OWNER', 'ADMIN', 'HR_MANAGER', 'VIEWER']), orgsController.listMembers);
router.post(
  '/invite',
  requireOrgRole(['OWNER', 'ADMIN']),
  validate(inviteMemberSchema),
  orgsController.invite
);
router.patch(
  '/members/:membershipId/role',
  requireOrgRole(['OWNER', 'ADMIN']),
  validate(changeRoleSchema),
  orgsController.changeRole
);

const retentionSchema = z.object({
  body: z.object({ days: z.union([z.literal(30), z.literal(60), z.literal(90)]) }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

router.patch(
  '/settings/retention',
  requireOrgRole(['OWNER', 'ADMIN']),
  validate(retentionSchema),
  orgsController.setRetention
);

// Convenience: resolve current org context
router.get('/current', attachOrgContext, (req, res) => {
  res.json({ org: req.orgContext });
});

export default router;
