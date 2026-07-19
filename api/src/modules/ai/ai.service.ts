import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, getObjectBytes, headObjectSize, readObjectHead } from '../../lib/s3';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';
import { detectFileCategory } from '../../../../shared/fileType';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { getAiProvider, isAiConfigured, type AiMessage } from '../../lib/ai/provider';
import { extractPdfText, assertHasText } from '../../lib/pdfText';
import type { ChatInput, ExplainInput, SummarizeInput } from './ai.types';

const AI_PREFIX = 'pdf-saas-ai';
const AI_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Extraction reads the whole file into memory — cap it to protect the process. */
const AI_MAX_BYTES = 30 * 1024 * 1024;
/** Keep only the most recent turns so a long chat can't grow the prompt unbounded. */
const MAX_CHAT_TURNS = 20;

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

export const aiService = {
  async presignUpload(userId: string, input: { fileName: string }) {
    if (!isAiConfigured()) throw new AppError('AI features are not available right now.', 503);
    const sanitized = input.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileKey = `${AI_PREFIX}/user-${userId}/${crypto.randomUUID()}_${sanitized}`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: fileKey, ContentType: 'application/pdf' }),
      { expiresIn: env.PRESIGN_TTL_SECONDS }
    );
    return { uploadUrl, fileKey };
  },

  async summarize(userId: string, plan: 'FREE' | 'PRO', input: SummarizeInput) {
    const text = await this.prepareDocument(userId, input.fileKey);
    return this.runOneShot(userId, plan, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${SUMMARY_PROMPTS[input.style]}\n\n--- DOCUMENT ---\n${text}` },
    ]);
  },

  async explain(userId: string, plan: 'FREE' | 'PRO', input: ExplainInput) {
    const text = await this.prepareDocument(userId, input.fileKey);
    return this.runOneShot(userId, plan, [
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
  async chat(userId: string, plan: 'FREE' | 'PRO', input: ChatInput) {
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
  async runOneShot(userId: string, plan: 'FREE' | 'PRO', messages: AiMessage[], maxTokens = 1024) {
    await reserveAiCredit(userId, PLAN_LIMITS[plan].maxMonthlyAiCredits, plan);
    try {
      const { text, usage } = await getAiProvider().complete(messages, { maxTokens });
      if (!text) throw new AppError('The AI could not produce a response for this document.', 502);
      logger.info({ userId, model: env.AI_MODEL, ...usage }, 'AI response generated');
      return { text, model: env.AI_MODEL, usage };
    } catch (err) {
      await refundAiCredit(userId).catch(() => undefined);
      if (err instanceof AppError) throw err;
      logger.error({ err, userId }, 'AI provider call failed');
      throw new AppError('The AI service is temporarily unavailable. Please try again.', 503);
    }
  },

  /**
   * Validates ownership + the real bytes, then extracts and returns the text.
   * Runs BEFORE any credit is reserved, so a bad or scanned file never costs.
   */
  async prepareDocument(userId: string, fileKey: string): Promise<string> {
    if (!isAiConfigured()) {
      throw new AppError('AI features are not available right now. Please try again later.', 503);
    }
    if (!fileKey.startsWith(`${AI_PREFIX}/user-${userId}/`)) {
      throw new AppError('Invalid file for this account.', 400);
    }

    let size: number;
    try {
      size = await headObjectSize(fileKey);
    } catch {
      throw new AppError('The uploaded file could not be found. Please re-upload.', 400);
    }
    if (size <= 0) throw new AppError('The uploaded file is empty.', 400);
    if (size > AI_MAX_BYTES) {
      throw new AppError(`This PDF is too large for AI processing (max ${Math.floor(AI_MAX_BYTES / 1024 / 1024)}MB).`, 400);
    }

    const head = await readObjectHead(fileKey, 1024);
    if (detectFileCategory(head) !== 'pdf') throw new AppError('Only PDF files are supported.', 400);

    const extracted = await extractPdfText(await getObjectBytes(fileKey));
    assertHasText(extracted);
    return extracted.text;
  },

  async getQuota(userId: string, plan: 'FREE' | 'PRO') {
    const [rows]: any = await getPool().query(
      'SELECT monthlyAiUsed, monthlyAiResetAt FROM tbl_user WHERE id = ?',
      [userId]
    );
    const row = rows[0];
    const limit = PLAN_LIMITS[plan].maxMonthlyAiCredits;
    const windowElapsed =
      !row?.monthlyAiResetAt || new Date(row.monthlyAiResetAt).getTime() < Date.now() - AI_WINDOW_MS;
    const used = windowElapsed ? 0 : Number(row.monthlyAiUsed ?? 0);
    return { used, limit, remaining: Math.max(0, limit - used), plan };
  },
};

/** Atomic monthly-credit reservation — same guarded UPDATE as the signing quota. */
async function reserveAiCredit(userId: string, limit: number, plan: 'FREE' | 'PRO'): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AI_WINDOW_MS);
  const [reserve]: any = await getPool().query(
    `UPDATE tbl_user
        SET monthlyAiUsed    = IF(monthlyAiResetAt < ?, 1, monthlyAiUsed + 1),
            monthlyAiResetAt = IF(monthlyAiResetAt < ?, ?, monthlyAiResetAt)
      WHERE id = ? AND (monthlyAiResetAt < ? OR monthlyAiUsed < ?)`,
    [cutoff, cutoff, now, userId, cutoff, limit]
  );
  if (reserve.affectedRows === 0) {
    throw new AppError(
      plan === 'PRO'
        ? `You've used all ${limit} AI requests for this month. It resets on a rolling 30-day basis.`
        : `You've used all ${limit} free AI requests this month. Upgrade to PRO for more.`,
      403
    );
  }
}

async function refundAiCredit(userId: string): Promise<void> {
  await getPool().query(
    'UPDATE tbl_user SET monthlyAiUsed = GREATEST(monthlyAiUsed - 1, 0) WHERE id = ?',
    [userId]
  );
}
