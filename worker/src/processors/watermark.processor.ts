import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { logger } from '../lib/logger';
import { WatermarkOptions } from '../../../shared/types';

export async function watermarkProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: WatermarkOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, text: options.text }, 'Starting Watermark PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for watermark operation');
  }

  let localInputPath = '';
  let watermarkedLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    // 2. Load PDF document
    const fileBytes = await fs.promises.readFile(localInputPath);
    const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
    
    // 3. Load Helvetica standard font
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const text = options.text;
    const fontSize = options.fontSize || 36;
    const opacity = options.opacity !== undefined ? options.opacity : 0.3;
    const position = options.position || 'center';

    const pageCount = pdfDoc.getPageCount();

    // 4. Draw watermark on each page
    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.getPage(i);
      const { width, height } = page.getSize();
      
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const textHeight = fontSize;

      let x = 0;
      let y = 0;
      let rotation = degrees(0);

      // Determine positioning coordinates
      switch (position) {
        case 'top-left':
          x = 30;
          y = height - textHeight - 30;
          break;
        case 'top-center':
          x = (width - textWidth) / 2;
          y = height - textHeight - 30;
          break;
        case 'top-right':
          x = width - textWidth - 30;
          y = height - textHeight - 30;
          break;
        case 'center':
          x = (width - textWidth) / 2;
          y = (height - textHeight) / 2;
          // Apply a premium diagonal tilt to center watermarks
          rotation = degrees(45);
          break;
        case 'bottom-left':
          x = 30;
          y = 30;
          break;
        case 'bottom-center':
          x = (width - textWidth) / 2;
          y = 30;
          break;
        case 'bottom-right':
          x = width - textWidth - 30;
          y = 30;
          break;
        default:
          x = (width - textWidth) / 2;
          y = (height - textHeight) / 2;
      }

      // If rotated center watermark, adjust X/Y to keep it anchored correctly
      if (position === 'center') {
        page.drawText(text, {
          x: width / 2 - textWidth / 2 + 30, // shift slightly for rotation offset
          y: height / 2 - textHeight / 2 - 30,
          size: fontSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity,
          rotate: rotation,
        });
      } else {
        page.drawText(text, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity,
        });
      }
    }

    const watermarkedBytes = await pdfDoc.save();

    // 5. Save locally
    const tempDir = path.join(process.cwd(), 'temp');
    watermarkedLocalPath = path.join(tempDir, `watermark_${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(watermarkedLocalPath, watermarkedBytes);

    // 6. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/watermarked_${Date.now()}.pdf`;
    await uploadToS3(watermarkedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (watermarkedLocalPath) {
      cleanupLocalFile(watermarkedLocalPath);
    }
  }
}
