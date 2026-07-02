import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { logger } from '../lib/logger';
import { PdfToJpgOptions } from '../../../shared/types';

export async function pdfToJpgProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: PdfToJpgOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId }, 'Starting PDF to JPG processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for PDF to JPG conversion');
  }

  let localInputPath = '';
  const generatedFiles: string[] = [];
  let zipLocalPath = '';

  try {
    // 1. Download input file
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    const tempDir = path.join(process.cwd(), 'temp');
    const outputPrefix = path.join(tempDir, `raster_${crypto.randomUUID()}`);

    const dpi = options.dpi || 150;

    // pdftoppm arguments: -jpeg -r <dpi> <input_file> <output_prefix>
    const args = [
      '-jpeg',
      '-r',
      dpi.toString(),
      localInputPath,
      outputPrefix,
    ];

    // 2. Run pdftoppm
    await executeBinary('pdftoppm', args);

    // 3. Find all generated JPG files
    const dirFiles = fs.readdirSync(tempDir);
    const prefixBase = path.basename(outputPrefix);
    
    const pageFiles = dirFiles
      .filter((file) => file.startsWith(prefixBase) && file.endsWith('.jpg'))
      .map((file) => path.join(tempDir, file))
      // Ensure pages are sorted numerically
      .sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        return numA - numB;
      });

    if (pageFiles.length === 0) {
      throw new Error('pdftoppm did not generate any JPEG images');
    }

    generatedFiles.push(...pageFiles);

    // 4. Output logic: If single page, upload directly. If multiple, create a ZIP file.
    if (pageFiles.length === 1) {
      const destinationKey = `pdf-saas-results/job-${jobId}/page_1_${Date.now()}.jpg`;
      await uploadToS3(pageFiles[0], destinationKey, 'image/jpeg');
      return { outputFileKey: destinationKey };
    } else {
      // Create ZIP
      zipLocalPath = path.join(tempDir, `images_${crypto.randomUUID()}.zip`);
      const outputStream = fs.createWriteStream(zipLocalPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const archivePromise = new Promise<void>((resolve, reject) => {
        outputStream.on('close', resolve);
        archive.on('error', reject);
      });

      archive.pipe(outputStream);

      // Add each file to the archive
      pageFiles.forEach((file, index) => {
        archive.file(file, { name: `page-${index + 1}.jpg` });
      });

      await archive.finalize();
      await archivePromise;

      const destinationKey = `pdf-saas-results/job-${jobId}/pages_${Date.now()}.zip`;
      await uploadToS3(zipLocalPath, destinationKey, 'application/zip');
      
      return { outputFileKey: destinationKey };
    }
  } finally {
    cleanupLocalFile(localInputPath);
    generatedFiles.forEach((f) => cleanupLocalFile(f));
    if (zipLocalPath) {
      cleanupLocalFile(zipLocalPath);
    }
  }
}
