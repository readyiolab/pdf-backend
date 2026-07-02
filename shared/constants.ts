import { ToolName } from './types';

export const HEAVY_JOBS_QUEUE = 'heavy-jobs';
export const LIGHT_JOBS_QUEUE = 'light-jobs';

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
