import crypto from 'crypto';
import { QueueEvents } from 'bullmq';
import { readObjectHeadWithSize } from '../../lib/s3';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import { AppError } from '../../middleware/errorHandler.middleware';
import { detectFileCategory } from '../../../../shared/fileType';
import { PLAN_LIMITS, AI_EXTRACT_QUEUE } from '../../../../shared/constants';
import { getAiProvider, isAiConfigured, type AiMessage } from '../../lib/ai/provider';
import { toAiAppError } from '../../lib/ai/errors';
import type { ChatInput, ExplainInput, SummarizeInput } from './ai.types';
import { asPlan, getStorageForUser, resolveUserStorageContext } from '../../lib/storage';
import type { Plan } from '../../../../shared/types';
import { aiExtractQueue, enqueueAiExtract } from '../../lib/letterQueues';

const AI_PREFIX = 'pdf-saas-ai';
const AI_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Extraction reads the whole file into memory on the worker — cap it to protect the process. */
const AI_MAX_BYTES = 30 * 1024 * 1024;
/** Keep only the most recent turns so a long chat can't grow the prompt unbounded. */
const MAX_CHAT_TURNS = 20;
/** Cache extracted PDF text so chat turns don't re-download + re-parse. */
const AI_TEXT_CACHE_PREFIX = 'ai:pdftext:';
const AI_EXTRACT_WAIT_MS = 120_000;

const SYSTEM_PROMPT =
  'You are a precise document assistant. You answer strictly from the provided document text, never inventing facts that are not in it. If the answer is not in the document, say so plainly. Keep answers clear and well-structured.';

const SUMMARY_PROMPTS: Record<string, string> = {
  concise: 'Summarize the document below in a few clear sentences — its main purpose and most important points.',
  detailed: 'Write a thorough summary of the document below: its purpose, key sections, important details, and any conclusions or action items. Use short paragraphs.',
  bullets: 'Summarize the document below as a bulleted list of its most important points, in order. One line per bullet.',
};

const EXPLAIN_PROMPTS: Record<string, string> = {
  simple: 'Explain what the document below is about in plain, simple language, as if to someone unfamiliar with the topic. Cover what it is, who it is for, and what it means for the reader.',
  legal: 'Explain the document below in plain language, focusing on obligations, rights, deadlines, and anything the reader should be careful about. Flag unusual or risky clauses. This is not legal advice.',
  technical: 'Explain the document below for a technical reader: the key concepts, how the pieces fit together, and any important specifics.',
};

function isOwnedAiKey(fileKey: string, userId: string, organizationId: string | null): boolean {
  if (organizationId && fileKey.startsWith(`org-${organizationId}/ai/`)) return true;
  return fileKey.startsWith(`${AI_PREFIX}/user-${userId}/`);
}

let aiExtractEvents: QueueEvents | null = null;

function getAiExtractEvents(): QueueEvents {
  if (!aiExtractEvents) {
    aiExtractEvents = new QueueEvents(AI_EXTRACT_QUEUE, { connection: redis as any });
  }
  return aiExtractEvents;
}

export const aiService = {
  async presignUpload(userId: string, input: { fileName: string }) {
    if (!isAiConfigured()) throw new AppError('AI features are not available right now.', 503);
    const sanitized = input.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const { storage, organizationId } = await getStorageForUser(userId);
    const fileKey = organizationId
      ? `org-${organizationId}/ai/${crypto.randomUUID()}_${sanitized}`
      : `${AI_PREFIX}/user-${userId}/${crypto.randomUUID()}_${sanitized}`;
    const uploadUrl = await storage.presignPut(fileKey, 'application/pdf', env.PRESIGN_TTL_SECONDS);
    return { uploadUrl, fileKey };
  },

  async summarize(userId: string, plan: Plan, input: SummarizeInput) {
    const text = await this.prepareDocument(userId, input.fileKey);
    return this.runOneShot(userId, asPlan(plan), [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${SUMMARY_PROMPTS[input.style]}\n\n--- DOCUMENT ---\n${text}` },
    ]);
  },

  async explain(userId: string, plan: Plan, input: ExplainInput) {
    const text = await this.prepareDocument(userId, input.fileKey);
    return this.runOneShot(userId, asPlan(plan), [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${EXPLAIN_PROMPTS[input.audience]}\n\n--- DOCUMENT ---\n${text}` },
    ]);
  },

  /**
   * Chat over a document.
   *
   * Stateless: the client resends the conversation each turn, and the document
   * text is re-attached as system context. The history is trimmed to the most
   * recent turns so cost is bounded, and the document sits in a system message
   * so the user's own turns can't overwrite or spoof it.
   */
  async chat(userId: string, plan: Plan, input: ChatInput) {
    const text = await this.prepareDocument(userId, input.fileKey);
    const history = input.messages.slice(-MAX_CHAT_TURNS);

    const messages: AiMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `The user is asking about this document:\n\n--- DOCUMENT ---\n${text}` },
      ...history.map((m) => ({ role: m.role, content: m.content }) as AiMessage),
    ];
    return this.runOneShot(userId, plan, messages, 1024);
  },

  /** Reserves a credit, calls the model, refunds on failure. Shared by all three. */
  async runOneShot(userId: string, plan: Plan, messages: AiMessage[], maxTokens = 1024) {
    const normalized = asPlan(plan);
    await reserveAiCredit(userId, PLAN_LIMITS[normalized].maxMonthlyAiCredits, normalized);
    try {
      const { text, usage } = await getAiProvider().complete(messages, { maxTokens });
      if (!text) throw new AppError('The AI could not produce a response for this document.', 502);
      logger.info({ userId, model: env.AI_MODEL, ...usage }, 'AI response generated');
      return { text, model: env.AI_MODEL, usage };
    } catch (err) {
      await refundAiCredit(userId).catch(() => undefined);
      if (err instanceof AppError) throw err;
      logger.error({ err, userId }, 'AI provider call failed');
      throw toAiAppError(err);
    }
  },

  /**
   * Validates ownership + magic bytes on the API, then extracts text via the
   * dedicated worker (cache-hit stays synchronous on Redis).
   */
  async prepareDocument(userId: string, fileKey: string): Promise<string> {
    if (!isAiConfigured()) {
      throw new AppError('AI features are not available right now. Please try again later.', 503);
    }
    const { organizationId, storageBindingId } = await resolveUserStorageContext(userId);
    if (!isOwnedAiKey(fileKey, userId, organizationId)) {
      throw new AppError('Invalid file for this account.', 400);
    }

    const cacheKey = `${AI_TEXT_CACHE_PREFIX}${fileKey}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info({ fileKey }, 'AI text cache hit');
        return cached;
      }
    } catch (err) {
      logger.warn({ err }, 'AI text cache read failed — extracting fresh');
    }

    let size: number;
    let head: Buffer;
    try {
      const probe = await readObjectHeadWithSize(fileKey, 1024, storageBindingId);
      size = probe.size;
      head = probe.bytes;
    } catch {
      throw new AppError('The uploaded file could not be found. Please re-upload.', 400);
    }
    if (size <= 0) throw new AppError('The uploaded file is empty.', 400);
    if (size > AI_MAX_BYTES) {
      throw new AppError(
        `This PDF is too large for AI processing (max ${Math.floor(AI_MAX_BYTES / 1024 / 1024)}MB).`,
        400
      );
    }
    if (detectFileCategory(head) !== 'pdf') throw new AppError('Only PDF files are supported.', 400);

    try {
      const jobId = await enqueueAiExtract({
        fileKey,
        userId,
        organizationId,
        storageBindingId,
      });

      const bullJob = await aiExtractQueue.getJob(jobId);
      if (bullJob) {
        const state = await bullJob.getState();
        if (state === 'completed') {
          const result = bullJob.returnvalue as { text?: string } | undefined;
          if (result?.text) return result.text;
          const cachedDone = await redis.get(cacheKey).catch(() => null);
          if (cachedDone) return cachedDone;
        }
        try {
          const result = (await bullJob.waitUntilFinished(
            getAiExtractEvents(),
            AI_EXTRACT_WAIT_MS
          )) as { text?: string };
          if (result?.text) return result.text;
        } catch (err) {
          logger.warn({ err, fileKey }, 'AI extract waitUntilFinished failed — polling cache');
        }
      }

      const deadline = Date.now() + AI_EXTRACT_WAIT_MS;
      while (Date.now() < deadline) {
        const cached = await redis.get(cacheKey).catch(() => null);
        if (cached) return cached;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new AppError('Document text extraction timed out. Please try again.', 504);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const msg = String((err as Error)?.message || err);
      if (msg.includes('scanned') || msg.includes('extractable text') || msg.includes('OCR')) {
        throw new AppError(
          'This looks like a scanned PDF with no readable text. Run it through OCR first, then try again.',
          422
        );
      }
      if (msg.includes('too large')) throw new AppError(msg, 400);
      logger.error({ err, fileKey }, 'AI extract failed');
      throw new AppError('Could not extract text from this PDF. Please try again.', 502);
    }
  },

  async getQuota(userId: string, plan: Plan) {
    const normalized = asPlan(plan);
    const row = await db.select('tbl_user', 'monthlyAiUsed, monthlyAiResetAt', 'id = ?', [userId]);
    const limit = PLAN_LIMITS[normalized].maxMonthlyAiCredits;
    const windowElapsed =
      !row?.monthlyAiResetAt || new Date(row.monthlyAiResetAt).getTime() < Date.now() - AI_WINDOW_MS;
    const used = windowElapsed ? 0 : Number(row?.monthlyAiUsed ?? 0);
    return { used, limit, remaining: Math.max(0, limit - used), plan: normalized };
  },
};

/** Atomic monthly-credit reservation — same guarded UPDATE as the signing quota. */
async function reserveAiCredit(userId: string, limit: number, plan: Plan): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AI_WINDOW_MS);
  const reserve = await db.execute(
    `UPDATE tbl_user
        SET monthlyAiUsed    = IF(monthlyAiResetAt < ?, 1, monthlyAiUsed + 1),
            monthlyAiResetAt = IF(monthlyAiResetAt < ?, ?, monthlyAiResetAt)
      WHERE id = ? AND (monthlyAiResetAt < ? OR monthlyAiUsed < ?)`,
    [cutoff, cutoff, now, userId, cutoff, limit]
  );
  if (reserve.affectedRows === 0) {
    throw new AppError(
      plan === 'FREE'
        ? `You've used all ${limit} free AI requests this month. Upgrade to PRO for more.`
        : `You've used all ${limit} AI requests for this month. It resets on a rolling 30-day basis.`,
      403
    );
  }
}

async function refundAiCredit(userId: string): Promise<void> {
  await db.execute(
    'UPDATE tbl_user SET monthlyAiUsed = GREATEST(monthlyAiUsed - 1, 0) WHERE id = ?',
    [userId]
  );
}
