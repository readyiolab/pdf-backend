import { Router } from 'express';
import { aiController } from './ai.controller';
import { authMiddleware, requireFullAccount } from '../../middleware/auth.middleware';
import { aiRateLimiter } from '../../middleware/rateLimit.middleware';
import { validate } from '../../middleware/validate.middleware';
import { aiPresignSchema, chatSchema, explainSchema, summarizeSchema } from './ai.types';

const router = Router();

// Every AI route requires a real (non-guest) account — AI calls cost money and
// must be attributable and quota-bounded to a durable user.
router.use(authMiddleware, requireFullAccount);

router.get('/quota', aiController.getQuota);
router.post('/presign', validate(aiPresignSchema), aiController.presignUpload);

// The three AI actions share the per-minute limiter (the monthly credit quota
// is the real spend guardrail; this caps burst).
router.post('/summarize', aiRateLimiter, validate(summarizeSchema), aiController.summarize);
router.post('/explain', aiRateLimiter, validate(explainSchema), aiController.explain);
router.post('/chat', aiRateLimiter, validate(chatSchema), aiController.chat);

export default router;
