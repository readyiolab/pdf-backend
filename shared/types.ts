export type JobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type Plan = 'FREE' | 'PRO';

export type ToolName =
  | 'merge'
  | 'split'
  | 'compress'
  | 'jpgToPdf'
  | 'pdfToJpg'
  | 'rotate'
  | 'watermark'
  | 'protect'
  | 'officeConvert'
  | 'ocr';

export interface MergeOptions {
  // Order of files to merge
  order?: number[];
}

export interface SplitOptions {
  // e.g. "1-5", "6-10", "1,3,5" or array of ranges
  ranges: string[];
}

export interface CompressOptions {
  // preset: screen (low res / small), ebook (medium res), printer (high res), prepress (color preserved)
  quality: 'low' | 'medium' | 'high';
}

export interface JpgToPdfOptions {
  // page layout / scaling options
  fit?: 'fill' | 'contain' | 'cover';
  orientation?: 'portrait' | 'landscape';
}

export interface PdfToJpgOptions {
  // DPI resolution
  dpi?: number;
}

export interface RotateOptions {
  // rotation angle: 90, 180, 270 (degrees clockwise)
  angle: 90 | 180 | 270;
  // Apply to specific pages (1-indexed), empty/omitted means all pages
  pages?: number[];
}

export interface WatermarkOptions {
  text: string;
  fontSize?: number;
  opacity?: number; // 0.0 to 1.0
  position: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
}

export interface ProtectOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: {
    print?: boolean;
    modify?: boolean;
    copy?: boolean;
  };
}

export interface OfficeConvertOptions {
  // Target format: typically pdf, pptx, docx, etc. In our tool we do Office -> PDF and PDF -> Office, so specify direction
  direction: 'to-pdf' | 'from-pdf';
}

export interface OcrOptions {
  // Languages to use: "eng", "hin", etc.
  languages: string[];
}

export type ToolOptions =
  | MergeOptions
  | SplitOptions
  | CompressOptions
  | JpgToPdfOptions
  | PdfToJpgOptions
  | RotateOptions
  | WatermarkOptions
  | ProtectOptions
  | OfficeConvertOptions
  | OcrOptions;

export interface JobPayload {
  jobId: string;
  userId: string | null;
  tool: ToolName;
  inputFiles: string[]; // S3 Keys
  options: Record<string, any>;
}
