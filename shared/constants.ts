import { ToolName } from './types';
import type { FileCategory } from './fileType';

export const HEAVY_JOBS_QUEUE = 'heavy-jobs';
export const LIGHT_JOBS_QUEUE = 'light-jobs';
export const MAINTENANCE_QUEUE = 'maintenance';
export const DEAD_JOBS_QUEUE = 'dead-jobs';

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

export const HEAVY_TOOLS: ToolName[] = ['compress', 'officeConvert', 'ocr'];
export const LIGHT_TOOLS: ToolName[] = ['merge', 'split', 'jpgToPdf', 'pdfToJpg', 'rotate', 'watermark', 'protect'];

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
   * AI requests (Chat/Summarize/Explain) allowed per rolling 30-day window.
   *
   * Separate from every other counter because each AI call costs real money at
   * the model's per-token rate — this is the guardrail against a single user
   * running up the Anthropic bill. Consumed per request. Same monthly cadence
   * and mechanism as maxMonthlySigns.
   */
  maxMonthlyAiCredits: number;
}

export const PLAN_LIMITS: Record<'FREE' | 'PRO', PlanLimits> = {
  FREE: {
    maxDailyOps: 5,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxMonthlySigns: 3, // enough to try the feature; upgrade for real use
    maxMonthlyAiCredits: 20, // a taste of AI; upgrade for real use
  },
  PRO: {
    maxDailyOps: 1000, // Practically unlimited compared to 5, but provides a safety guardrail
    maxFileSize: 100 * 1024 * 1024, // 100MB
    maxMonthlySigns: 200, // generous, but a guardrail against runaway email cost
    maxMonthlyAiCredits: 500, // generous, but bounds runaway token spend
  },
};

export const SUPPORTED_TOOLS: ToolName[] = [...HEAVY_TOOLS, ...LIGHT_TOOLS];
