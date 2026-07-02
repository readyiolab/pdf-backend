import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { logger } from '../lib/logger';
import { RotateOptions } from '../../../shared/types';

export async function rotateProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: RotateOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, angle: options.angle }, 'Starting Rotate PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for rotate operation');
  }

  let localInputPath = '';
  let rotatedLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    // 2. Load PDF
    const fileBytes = fs.readFileSync(localInputPath);
    const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    // 3. Process rotation per page
    const targetPages = options.pages 
      ? options.pages.map((p) => p - 1).filter((p) => p >= 0 && p < pageCount)
      : Array.from({ length: pageCount }, (_, i) => i);

    for (const pageIdx of targetPages) {
      const page = pdfDoc.getPage(pageIdx);
      const currentRotation = page.getRotation();
      // Rotation angle is cumulative, modulo 360
      const newRotationAngle = (currentRotation.angle + options.angle) % 360;
      page.setRotation(degrees(newRotationAngle));
    }

    const rotatedBytes = await pdfDoc.save();

    // 4. Save locally
    const tempDir = path.join(process.cwd(), 'temp');
    rotatedLocalPath = path.join(tempDir, `rotated_${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(rotatedLocalPath, rotatedBytes);

    // 5. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/rotated_${Date.now()}.pdf`;
    await uploadToS3(rotatedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (rotatedLocalPath) {
      cleanupLocalFile(rotatedLocalPath);
    }
  }
}
