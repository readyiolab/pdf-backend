import { PDFParse } from 'pdf-parse';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler.middleware';

export interface ExtractedText {
  text: string;
  pages: number;
  /** True when we hit AI_MAX_TEXT_CHARS and dropped the tail. */
  truncated: boolean;
}

/**
 * Extracts the text layer from a PDF for the AI features.
 *
 * We send the model text, not the raw PDF — this keeps the AI provider-agnostic
 * (works with any OpenAI chat model, no dependency on a specific file-input API)
 * and bounds cost: a 100-page PDF is capped at AI_MAX_TEXT_CHARS before it ever
 * reaches the model.
 *
 * A scanned PDF has no text layer, so extraction returns (near) nothing — the
 * caller turns that into a clear "run OCR first" message rather than sending an
 * empty prompt and paying for a useless answer.
 */
export async function extractPdfText(bytes: Buffer): Promise<ExtractedText> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    let text = (result.text ?? '').trim();
    const truncated = text.length > env.AI_MAX_TEXT_CHARS;
    if (truncated) {
      text = text.slice(0, env.AI_MAX_TEXT_CHARS) + '\n\n[Document truncated — too long to process in full.]';
    }
    return { text, pages: result.total ?? 0, truncated };
  } catch {
    throw new AppError('This file could not be read as a PDF.', 400);
  } finally {
    // Release the worker-side document; extraction is done.
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Rejects a document with too little text to be worth a paid model call.
 *
 * Below this, it's almost certainly a scanned/image PDF (no text layer) — we
 * fail before reserving a credit or calling the model.
 */
export function assertHasText(extracted: ExtractedText): void {
  if (extracted.text.replace(/\s+/g, '').length < 20) {
    throw new AppError(
      "This looks like a scanned PDF with no readable text. Run it through OCR first, then try again.",
      422
    );
  }
}
