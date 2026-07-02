import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { logger } from '../lib/logger';
import { CompressOptions } from '@shared/types';

export async function compressProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: CompressOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId }, 'Starting Compress PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for compression');
  }

  let localInputPath = '';
  let compressedLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    // 2. Map quality options to Ghostscript settings
    // /screen is lowest quality/size, /ebook is medium, /printer is high
    let gsSettings = '/ebook';
    if (options.quality === 'low') {
      gsSettings = '/screen';
    } else if (options.quality === 'high') {
      gsSettings = '/printer';
    }

    const tempDir = path.join(process.cwd(), 'temp');
    compressedLocalPath = path.join(tempDir, `compressed_${crypto.randomUUID()}.pdf`);

    // Determine binary name based on platform (gs on linux, gswin64c/gs on windows)
    const gsBinary = process.platform === 'win32' ? 'gswin64c' : 'gs';

    const args = [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      `-dPDFSETTINGS=${gsSettings}`,
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      `-sOutputFile=${compressedLocalPath}`,
      localInputPath,
    ];

    // 3. Execute Ghostscript
    try {
      await executeBinary(gsBinary, args);
    } catch (gsErr: any) {
      // Check if gs failed because it was not found, fallback to 'gs' on windows
      if (process.platform === 'win32' && gsErr.message.includes('ENOENT')) {
        logger.warn('gswin64c not found, trying fallback to gs');
        await executeBinary('gs', args);
      } else {
        throw gsErr;
      }
    }

    // 4. Verify output file exists and is not empty
    if (!fs.existsSync(compressedLocalPath) || fs.statSync(compressedLocalPath).size === 0) {
      throw new Error('Ghostscript produced an empty output file');
    }

    // 5. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/compressed_${Date.now()}.pdf`;
    await uploadToS3(compressedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (compressedLocalPath) {
      cleanupLocalFile(compressedLocalPath);
    }
  }
}
