import { ToolName } from './types';
import type { FileCategory } from './fileType';

export const HEAVY_JOBS_QUEUE = 'heavy-jobs';
export const LIGHT_JOBS_QUEUE = 'light-jobs';
export const MAINTENANCE_QUEUE = 'maintenance';
export const DEAD_JOBS_QUEUE = 'dead-jobs';
/** Dedicated queue for sealing signed PDFs (stamp + cert + PKCS#7). */
export const SIGN_FINALIZE_QUEUE = 'sign-finalize';

// Allowed input file categories per tool. Used to reject files whose real bytes
// don't match what the tool can process (defense against malicious uploads).
export const TOOL_INPUT_TYPES: Record<ToolName, FileCategory[]> = {
  merge: ['pdf'],
  split: ['pdf'],
  compress: ['pdf'],
  jpgToPdf: ['image'],
  pdfToJpg: ['pdf'],
  rotate: ['pdf'],
  watermark: ['pdf'],
  protect: ['pdf'],
  officeConvert: ['pdf', 'office'], // to-pdf accepts office; from-pdf accepts pdf
  ocr: ['pdf', 'image'],
};

export const HEAVY_TOOLS: ToolName[] = ['compress', 'officeConvert', 'ocr', 'merge', 'pdfToJpg'];
export const LIGHT_TOOLS: ToolName[] = ['split', 'jpgToPdf', 'rotate', 'watermark', 'protect'];

export interface PlanLimits {
  maxDailyOps: number;
  maxFileSize: number; // in bytes
  /**
   * How many documents a user may SEND for signature per rolling 30-day window.
   *
   * Deliberately a separate, MONTHLY allowance rather than sharing the daily
   * tool-ops counter: signing an agreement is a higher-value, lower-frequency
   * action (the industry counts monthly "envelopes"), and a user merging PDFs
   * all day shouldn't be locked out of signing, nor vice versa. Consumed only
   * when a document is actually sent — creating and designing drafts is free.
   *
   * These are the pricing knobs — change the numbers here, nothing else.
   */
  maxMonthlySigns: number;

  /**
   * Reusable e-sign templates (recipient roles + field layout) a plan may keep.
   * Aligned with Nitro Standard's small free allowance.
   */
  maxSignTemplates: number;

  /**
   * AI requests (Chat/Summarize/Explain) allowed per rolling 30-day window.
   *
   * Separate from every other counter because each AI call costs real money at
   * the model's per-token rate — this is the guardrail against a single user
   * running up the Anthropic bill. Consumed per request. Same monthly cadence
   * and mechanism as maxMonthlySigns.
   */
  maxMonthlyAiCredits: number;

  /** Max employees (rows) in a single Letter Studio batch. */
  maxLetterBatchRows: number;
  /** Whether the plan may send letters via connected Outlook/Gmail. */
  letterSendingEnabled: boolean;
}

export const PLAN_LIMITS: Record<'FREE' | 'PRO' | 'ENTERPRISE', PlanLimits> = {
  FREE: {
    maxDailyOps: 5,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxMonthlySigns: 3, // enough to try the feature; upgrade for real use
    maxSignTemplates: 3,
    maxMonthlyAiCredits: 20, // a taste of AI; upgrade for real use
    maxLetterBatchRows: 5,
    letterSendingEnabled: false,
  },
  PRO: {
    maxDailyOps: 1000, // Practically unlimited compared to 5, but provides a safety guardrail
    maxFileSize: 100 * 1024 * 1024, // 100MB
    maxMonthlySigns: 200, // generous, but a guardrail against runaway email cost
    maxSignTemplates: 50,
    maxMonthlyAiCredits: 500, // generous, but bounds runaway token spend
    maxLetterBatchRows: 500,
    letterSendingEnabled: true,
  },
  ENTERPRISE: {
    maxDailyOps: 10_000,
    maxFileSize: 500 * 1024 * 1024, // 500MB
    maxMonthlySigns: 5_000,
    maxSignTemplates: 500,
    maxMonthlyAiCredits: 10_000,
    maxLetterBatchRows: 5_000,
    letterSendingEnabled: true,
  },
};

/** Dedicated BullMQ queue for Letter Studio PDF generation. */
export const LETTER_GENERATE_QUEUE = 'letter-generate';
export const LETTER_PARSE_QUEUE = 'letter-parse';
export const LETTER_SEND_QUEUE = 'letter-send';
/** Background ZIP of batch letter PDFs (avoids streaming all objects through the API). */
export const LETTER_ZIP_QUEUE = 'letter-zip';
/** Offload AI PDF text extraction from the API process. */
export const AI_EXTRACT_QUEUE = 'ai-extract';

export const SUPPORTED_TOOLS: ToolName[] = [...HEAVY_TOOLS, ...LIGHT_TOOLS];
