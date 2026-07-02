import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { MergeOptions } from '../../../shared/types';

export async function mergeProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: MergeOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, fileCount: inputFileKeys.length }, 'Starting Merge PDF processing');

  const localPaths: string[] = [];
  let mergedLocalPath = '';

  try {
    // 1. Download all files from S3
    for (const key of inputFileKeys) {
      const localPath = await downloadFromS3(key);
      localPaths.push(localPath);
    }

    // 2. Sort files if order is provided
    let sortedPaths = [...localPaths];
    if (options.order && options.order.length === localPaths.length) {
      sortedPaths = options.order.map((index) => localPaths[index]);
    }

    // 3. Perform Merge using pdf-lib
    const mergedPdf = await PDFDocument.create();

    for (const filePath of sortedPaths) {
      const fileBytes = fs.readFileSync(filePath);
      const pdf = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      
      copiedPages.forEach((page) => {
        mergedPdf.addPage(page);
      });
    }

    const mergedBytes = await mergedPdf.save();
    
    // 4. Save to temporary local merged path
    const tempDir = path.join(process.cwd(), 'temp');
    mergedLocalPath = path.join(tempDir, `merged_${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(mergedLocalPath, mergedBytes);

    // 5. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/merged_${Date.now()}.pdf`;
    await uploadToS3(mergedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    // Cleanup temporary files
    localPaths.forEach((p) => cleanupLocalFile(p));
    if (mergedLocalPath) {
      cleanupLocalFile(mergedLocalPath);
    }
  }
}
