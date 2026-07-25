import { env } from '../config/env';

/**
 * Binary resolution for Linux/Ubuntu production.
 * Prefer apt packages on PATH; override with absolute paths via env when needed.
 *
 *   sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin
 */

export function resolvePdftoppm(): string {
  return env.PDFTOPPM_PATH || 'pdftoppm';
}

export function resolveTesseract(): string {
  return env.TESSERACT_PATH || 'tesseract';
}

/**
 * Optional tessdata directory (must include language packs AND configs/pdf + pdf.ttf).
 * Leave unset on Ubuntu so Tesseract uses the system tessdata from apt.
 */
export function resolveTessdataDir(): string | undefined {
  return env.TESSDATA_DIR || undefined;
}
