import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { executeBinary } from '../lib/exec';
import { logger } from '../lib/logger';
import { ProtectOptions } from '@shared/types';

export async function protectProcessor(
  jobId: string,
  inputFileKeys: string[],
  options: ProtectOptions
): Promise<{ outputFileKey: string }> {
  logger.info({ jobId }, 'Starting Protect PDF processing');

  if (inputFileKeys.length === 0) {
    throw new Error('No input file provided for password protection');
  }

  let localInputPath = '';
  let protectedLocalPath = '';

  try {
    // 1. Download file from S3
    localInputPath = await downloadFromS3(inputFileKeys[0]);

    const tempDir = path.join(process.cwd(), 'temp');
    protectedLocalPath = path.join(tempDir, `protected_${crypto.randomUUID()}.pdf`);

    const userPassword = options.userPassword || '';
    const ownerPassword = options.ownerPassword || userPassword || 'owner_secret_pass_123';

    // Compile qpdf arguments
    // qpdf --encrypt user-password owner-password key-length [restrictions] -- input.pdf output.pdf
    const args = [
      '--encrypt',
      userPassword,
      ownerPassword,
      '256', // 256-bit encryption
    ];

    // Handle permissions restrictions if provided
    if (options.permissions) {
      if (options.permissions.print === false) {
        args.push('--print=none');
      }
      if (options.permissions.modify === false) {
        args.push('--modify=none');
      }
      if (options.permissions.copy === false) {
        args.push('--extract=n');
      }
    }

    // Add separator and file paths
    args.push('--', localInputPath, protectedLocalPath);

    // 2. Execute qpdf
    await executeBinary('qpdf', args);

    // 3. Verify output
    if (!fs.existsSync(protectedLocalPath) || fs.statSync(protectedLocalPath).size === 0) {
      throw new Error('qpdf produced an empty protected file');
    }

    // 4. Upload to S3
    const destinationKey = `pdf-saas-results/job-${jobId}/protected_${Date.now()}.pdf`;
    await uploadToS3(protectedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey: destinationKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (protectedLocalPath) {
      cleanupLocalFile(protectedLocalPath);
    }
  }
}
