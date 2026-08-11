import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { resolvePdftoppm, resolveTesseract, resolveTessdataDir } from '../lib/binaries';
import { logger } from '../lib/logger';
import { OcrOptions } from '../../../shared/types';

const TESSERACT_TIMEOUT_MS = 180_000;

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

    // 2. Rasterize PDF to JPEGs using pdftoppm (from poppler-utils on Ubuntu)
    const rasterPrefix = path.join(tempDir, `ocr_raster_${crypto.randomUUID()}`);
    await executeBinary(resolvePdftoppm(), ['-jpeg', '-r', '150', localInputPath, rasterPrefix]);

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
    // Requires: tesseract-ocr + language packs (e.g. tesseract-ocr-eng tesseract-ocr-hin)
    const langArg = options.languages?.join('+') || 'eng';
    const tessdataDir = resolveTessdataDir();
    const tesseractBin = resolveTesseract();

    for (let i = 0; i < pageImages.length; i++) {
      const imgPath = pageImages[i];
      const ocrOutputBase = path.join(tempDir, `ocr_page_${crypto.randomUUID()}`);

      // tesseract <image> <outputbase> [-l lang] pdf
      const tessArgs = [imgPath, ocrOutputBase];
      if (tessdataDir) {
        tessArgs.push('--tessdata-dir', tessdataDir);
      }
      tessArgs.push('-l', langArg, 'pdf');

      const { stderr } = await executeBinary(tesseractBin, tessArgs, {
        timeout: TESSERACT_TIMEOUT_MS,
      });

      const expectedPdfPath = `${ocrOutputBase}.pdf`;
      if (!fs.existsSync(expectedPdfPath)) {
        const hint = stderr?.trim()
          ? stderr.trim()
          : 'Ensure system tessdata includes the pdf config (Ubuntu: apt install tesseract-ocr). Do not set TESSDATA_DIR to a langs-only folder.';
        throw new Error(`Tesseract failed to generate OCR PDF for page ${i + 1}: ${hint}`);
      }

      ocrPageFiles.push(expectedPdfPath);
    }

    // 4. Merge searchable page PDFs
    const mergedOcrPdf = await PDFDocument.create();

    for (const pagePdfPath of ocrPageFiles) {
      const fileBytes = await fs.promises.readFile(pagePdfPath);
      const pageDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
      const copiedPages = await mergedOcrPdf.copyPages(pageDoc, pageDoc.getPageIndices());
      copiedPages.forEach((page) => mergedOcrPdf.addPage(page));
    }

    const mergedBytes = await mergedOcrPdf.save();

    mergedOcrPath = path.join(tempDir, `ocr_final_${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(mergedOcrPath, mergedBytes);

    // 5. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/ocr_${Date.now()}.pdf`;
    const outputFileKey = await uploadToS3(mergedOcrPath, destinationKey, 'application/pdf');

    return { outputFileKey };
  } finally {
    cleanupLocalFile(localInputPath);
    rasterFiles.forEach((f) => cleanupLocalFile(f));
    ocrPageFiles.forEach((f) => cleanupLocalFile(f));
    if (mergedOcrPath) {
      cleanupLocalFile(mergedOcrPath);
    }
  }
}
