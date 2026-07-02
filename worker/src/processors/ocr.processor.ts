import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { logger } from '../lib/logger';
import { OcrOptions } from '../../../shared/types';

export async function ocrProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: OcrOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, languages: options.languages }, 'Starting OCR PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for OCR');
  }

  let localInputPath = '';
  const rasterFiles: string[] = [];
  const ocrPageFiles: string[] = [];
  let mergedOcrPath = '';

  try {
    // 1. Download input file
    localInputPath = await downloadFromS3(inputFileKeys[0]);
    const tempDir = path.dirname(localInputPath);

    // 2. Rasterize PDF to JPEGs using pdftoppm
    const rasterPrefix = path.join(tempDir, `ocr_raster_${crypto.randomUUID()}`);
    
    // pdftoppm -jpeg -r 150 <input> <prefix>
    await executeBinary('pdftoppm', ['-jpeg', '-r', '150', localInputPath, rasterPrefix]);

    // Find all rasterized files
    const dirFiles = fs.readdirSync(tempDir);
    const prefixBase = path.basename(rasterPrefix);

    const pageImages = dirFiles
      .filter((file) => file.startsWith(prefixBase) && file.endsWith('.jpg'))
      .map((file) => path.join(tempDir, file))
      .sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        return numA - numB;
      });

    if (pageImages.length === 0) {
      throw new Error('Failed to rasterize PDF for OCR (no images generated)');
    }

    rasterFiles.push(...pageImages);

    // 3. Run Tesseract on each page image to output a searchable PDF page
    const langArg = options.languages?.join('+') || 'eng';

    for (let i = 0; i < pageImages.length; i++) {
      const imgPath = pageImages[i];
      const ocrOutputBase = path.join(tempDir, `ocr_page_${crypto.randomUUID()}`);
      
      // Command: tesseract <img_path> <output_base> -l <lang> pdf
      await executeBinary('tesseract', [
        imgPath,
        ocrOutputBase,
        '-l',
        langArg,
        'pdf',
      ]);

      const expectedPdfPath = `${ocrOutputBase}.pdf`;
      if (!fs.existsSync(expectedPdfPath)) {
        throw new Error(`Tesseract failed to generate OCR PDF for page ${i + 1}`);
      }

      ocrPageFiles.push(expectedPdfPath);
    }

    // 4. Merge all searchable page PDFs into a single final PDF using pdf-lib
    const mergedOcrPdf = await PDFDocument.create();

    for (const pagePdfPath of ocrPageFiles) {
      const fileBytes = fs.readFileSync(pagePdfPath);
      const pageDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
      const copiedPages = await mergedOcrPdf.copyPages(pageDoc, pageDoc.getPageIndices());
      copiedPages.forEach((page) => mergedOcrPdf.addPage(page));
    }

    const mergedBytes = await mergedOcrPdf.save();
    
    mergedOcrPath = path.join(tempDir, `ocr_final_${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(mergedOcrPath, mergedBytes);

    // 5. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/ocr_${Date.now()}.pdf`;
    await uploadToS3(mergedOcrPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    // Cleanup all local resources
    cleanupLocalFile(localInputPath);
    rasterFiles.forEach((f) => cleanupLocalFile(f));
    ocrPageFiles.forEach((f) => cleanupLocalFile(f));
    if (mergedOcrPath) {
      cleanupLocalFile(mergedOcrPath);
    }
  }
}
