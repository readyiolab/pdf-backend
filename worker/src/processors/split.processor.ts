import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { logger } from '../lib/logger';
import { SplitOptions } from '@shared/types';
import { AppError } from '../../../api/src/middleware/errorHandler.middleware'; // Reuse AppError structure or standard Error

function parseRanges(ranges: string[], maxPages: number): number[] {
  const indices = new Set<number>();
  for (const range of ranges) {
    const parts = range.trim().split('-');
    if (parts.length === 1) {
      const idx = parseInt(parts[0], 10) - 1;
      if (idx >= 0 && idx < maxPages) {
        indices.add(idx);
      }
    } else if (parts.length === 2) {
      const start = parseInt(parts[0], 10) - 1;
      const end = parseInt(parts[1], 10) - 1;
      const actualStart = Math.max(0, Math.min(start, maxPages - 1));
      const actualEnd = Math.max(0, Math.min(end, maxPages - 1));
      for (let i = Math.min(actualStart, actualEnd); i <= Math.max(actualStart, actualEnd); i++) {
        indices.add(i);
      }
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

export async function splitProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: SplitOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId }, 'Starting Split PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for split operation');
  }

  let localInputPath = '';
  let splitLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    // 2. Load PDF document
    const fileBytes = fs.readFileSync(localInputPath);
    const srcPdf = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
    const maxPages = srcPdf.getPageCount();

    // 3. Parse target page indices
    const pageIndices = parseRanges(options.ranges, maxPages);
    if (pageIndices.length === 0) {
      throw new Error(`Invalid page range. Document has only ${maxPages} pages.`);
    }

    // 4. Create new PDF and copy selected pages
    const splitPdf = await PDFDocument.create();
    const copiedPages = await splitPdf.copyPages(srcPdf, pageIndices);
    copiedPages.forEach((page) => splitPdf.addPage(page));

    const splitBytes = await splitPdf.save();

    // 5. Save locally
    const tempDir = path.join(process.cwd(), 'temp');
    splitLocalPath = path.join(tempDir, `split_${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(splitLocalPath, splitBytes);

    // 6. Upload output to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/split_${Date.now()}.pdf`;
    await uploadToS3(splitLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (splitLocalPath) {
      cleanupLocalFile(splitLocalPath);
    }
  }
}
