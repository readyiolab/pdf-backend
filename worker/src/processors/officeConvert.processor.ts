import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { logger } from '../lib/logger';
import { OfficeConvertOptions } from '@shared/types';

export async function officeConvertProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: OfficeConvertOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId, direction: options.direction }, 'Starting Office to PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for Office conversion');
  }

  let localInputPath = '';
  let convertedLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);
    const tempDir = path.dirname(localInputPath);

    // Calculate expected output file name from LibreOffice
    // e.g. input: temp/uuid_name.docx -> output: temp/uuid_name.pdf
    const inputBasename = path.basename(localInputPath, path.extname(localInputPath));
    convertedLocalPath = path.join(tempDir, `${inputBasename}.pdf`);

    // Determine LibreOffice command based on platform (soffice.exe on windows, libreoffice on linux)
    const loBinary = process.platform === 'win32' ? 'soffice' : 'libreoffice';

    // LibreOffice headless arguments: --headless --convert-to pdf --outdir <outdir> <input_file>
    const args = [
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      tempDir,
      localInputPath,
    ];

    // 2. Run LibreOffice
    try {
      await executeBinary(loBinary, args);
    } catch (loErr: any) {
      if (process.platform === 'win32' && loErr.message.includes('ENOENT')) {
        logger.warn('soffice not found, trying fallback to libreoffice');
        await executeBinary('libreoffice', args);
      } else {
        throw loErr;
      }
    }

    // 3. Verify output
    if (!fs.existsSync(convertedLocalPath) || fs.statSync(convertedLocalPath).size === 0) {
      throw new Error('LibreOffice failed to generate converted PDF');
    }

    // 4. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/converted_${Date.now()}.pdf`;
    await uploadToS3(convertedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (convertedLocalPath) {
      cleanupLocalFile(convertedLocalPath);
    }
  }
}
