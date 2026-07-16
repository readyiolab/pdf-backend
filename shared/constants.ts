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
}

export const PLAN_LIMITS: Record<'FREE' | 'PRO', PlanLimits> = {
  FREE: {
    maxDailyOps: 5,
    maxFileSize: 10 * 1024 * 1024, // 10MB
  },
  PRO: {
    maxDailyOps: 1000, // Practically unlimited compared to 5, but provides a safety guardrail
    maxFileSize: 100 * 1024 * 1024, // 100MB
  },
};

export const SUPPORTED_TOOLS: ToolName[] = [...HEAVY_TOOLS, ...LIGHT_TOOLS];
