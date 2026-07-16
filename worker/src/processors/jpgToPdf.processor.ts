import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { logger } from '../lib/logger';
import { JpgToPdfOptions } from '../../../shared/types';

export async function jpgToPdfProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: JpgToPdfOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, imageCount: inputFileKeys.length }, 'Starting JPG to PDF processing');

  const localPaths: string[] = [];
  let pdfLocalPath = '';

  try {
    // 1. Download all input images
    for (const key of inputFileKeys) {
      const localPath = await downloadFromS3(key);
      localPaths.push(localPath);
    }

    const pdfDoc = await PDFDocument.create();

    // 2. Process each image with Sharp and embed in PDF
    for (const imgPath of localPaths) {
      // Normalize image to JPEG using Sharp (converts PNG/WebP to JPG and fetches metadata)
      const sharpImg = sharp(imgPath);
      const metadata = await sharpImg.metadata();
      
      const width = metadata.width || 600;
      const height = metadata.height || 800;

      // Convert to standard JPEG format
      const jpegBuffer = await sharpImg.jpeg({ quality: 90 }).toBuffer();

      // Embed the JPEG into the PDF Document
      const embeddedJpg = await pdfDoc.embedJpg(jpegBuffer);

      // Create a page with same dimensions as the image
      const page = pdfDoc.addPage([width, height]);
      
      // Draw the image filling the entire page
      page.drawImage(embeddedJpg, {
        x: 0,
        y: 0,
        width: width,
        height: height,
      });
    }

    const pdfBytes = await pdfDoc.save();

    // 3. Save PDF locally
    const tempDir = path.join(process.cwd(), 'temp');
    pdfLocalPath = path.join(tempDir, `jpg_to_pdf_${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(pdfLocalPath, pdfBytes);

    // 4. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/converted_${Date.now()}.pdf`;
    await uploadToS3(pdfLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    localPaths.forEach((p) => cleanupLocalFile(p));
    if (pdfLocalPath) {
      cleanupLocalFile(pdfLocalPath);
    }
  }
}
