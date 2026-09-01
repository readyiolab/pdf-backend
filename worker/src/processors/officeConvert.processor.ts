import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { logger } from '../lib/logger';
import { convertOfficeFileToPdf } from '../lib/officeToPdf';
import { OfficeConvertOptions } from '../../../shared/types';

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
    localInputPath = await downloadFromS3(inputFileKeys[0]);
    convertedLocalPath = await convertOfficeFileToPdf(localInputPath);

    const destinationKey = `pdf-saas-results/job-${jobId}/converted_${Date.now()}.pdf`;
    const outputFileKey = await uploadToS3(convertedLocalPath, destinationKey, 'application/pdf');

    return { outputFileKey };
  } finally {
    cleanupLocalFile(localInputPath);
    if (convertedLocalPath) {
      cleanupLocalFile(convertedLocalPath);
    }
  }
}
