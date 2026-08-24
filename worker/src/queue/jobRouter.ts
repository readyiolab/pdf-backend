import { Job } from 'bullmq';
import { JobPayload } from '../../../shared/types';
import { logger } from '../lib/logger';
import { db } from '../lib/mysql';
import { env } from '../config/env';
import { scanFile } from '../lib/clamav';
import { downloadFromS3, cleanupLocalFile, deleteFromS3 } from '../storage/s3';
import { jobStorageContext } from '../storage/context';
import { moveToDeadLetter } from './deadLetter';

// Import processors
import { mergeProcessor } from '../processors/merge.processor';
import { splitProcessor } from '../processors/split.processor';
import { compressProcessor } from '../processors/compress.processor';
import { jpgToPdfProcessor } from '../processors/jpgToPdf.processor';
import { pdfToJpgProcessor } from '../processors/pdfToJpg.processor';
import { rotateProcessor } from '../processors/rotate.processor';
import { watermarkProcessor } from '../processors/watermark.processor';
import { protectProcessor } from '../processors/protect.processor';
import { officeConvertProcessor } from '../processors/officeConvert.processor';
import { ocrProcessor } from '../processors/ocr.processor';

/**
 * Optional malware scan. Only runs when CLAMAV_ENABLED is true, in which case it
 * downloads each input, streams it to clamd, and throws on a detection so the
 * job never reaches the PDF parsers. A no-op (and zero I/O) when disabled.
 */
async function scanInputs(jobId: string, inputFiles: string[]): Promise<void> {
  if (!env.CLAMAV_ENABLED) return;

  const SCAN_CONCURRENCY = 4;
  let nextIdx = 0;
  let firstError: Error | null = null;

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, inputFiles.length) }, async () => {
      while (nextIdx < inputFiles.length) {
        if (firstError) return;
        const i = nextIdx++;
        const key = inputFiles[i];
        let localPath = '';
        try {
          localPath = await downloadFromS3(key);
          const result = await scanFile(localPath);
          if (!result.clean) {
            logger.warn({ jobId, key, signature: result.signature }, 'Malware detected in upload');
            firstError = new Error('Uploaded file failed the security scan and was rejected.');
            return;
          }
        } catch (err: any) {
          firstError = err instanceof Error ? err : new Error(String(err));
          return;
        } finally {
          if (localPath) cleanupLocalFile(localPath);
        }
      }
    })
  );

  if (firstError) throw firstError;
}

export async function jobRouter(job: Job<JobPayload>): Promise<void> {
  const { jobId, tool, inputFiles, options, organizationId, storageBindingId } = job.data;

  return jobStorageContext.run(
    {
      organizationId: organizationId ?? null,
      storageBindingId: storageBindingId ?? null,
    },
    async () => {
    logger.info({ jobId, tool, organizationId, storageBindingId }, 'Worker: Starting processing job');

    try {
      await db.execute('UPDATE tbl_job SET status = "PROCESSING" WHERE id = ?', [jobId]);
    } catch (dbErr) {
      logger.error({ jobId, dbErr }, 'Failed to update job status to PROCESSING in DB');
    }

    try {
      await job.updateProgress(5);
      await scanInputs(jobId, inputFiles);
      await job.updateProgress(20);

      let result: { outputFileKey: string };

      switch (tool) {
        case 'merge':
          result = await mergeProcessor(jobId, inputFiles, options);
          break;
        case 'split':
          result = await splitProcessor(jobId, inputFiles, options as any);
          break;
        case 'compress':
          result = await compressProcessor(jobId, inputFiles, options as any);
          break;
        case 'jpgToPdf':
          result = await jpgToPdfProcessor(jobId, inputFiles, options);
          break;
        case 'pdfToJpg':
          result = await pdfToJpgProcessor(jobId, inputFiles, options);
          break;
        case 'rotate':
          result = await rotateProcessor(jobId, inputFiles, options as any);
          break;
        case 'watermark':
          result = await watermarkProcessor(jobId, inputFiles, options as any);
          break;
        case 'protect':
          result = await protectProcessor(jobId, inputFiles, options as any);
          break;
        case 'officeConvert':
          result = await officeConvertProcessor(jobId, inputFiles, options as any);
          break;
        case 'ocr':
          result = await ocrProcessor(jobId, inputFiles, options as any);
          break;
        default:
          throw new Error(`Unsupported tool: ${tool}`);
      }

      await job.updateProgress(95);
      logger.info(
        { jobId, tool, outputFileKey: result.outputFileKey },
        'Worker: Job completed successfully'
      );

      await db.execute(
        'UPDATE tbl_job SET status = "COMPLETED", completedAt = ?, outputFile = ? WHERE id = ?',
        [new Date(), result.outputFileKey, jobId]
      );
      await job.updateProgress(100);
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown processing error';
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      logger.error(
        { jobId, tool, attempt: job.attemptsMade + 1, isFinalAttempt, err },
        'Worker: Job failed during processing'
      );

      if (isFinalAttempt) {
        try {
          await db.execute(
            'UPDATE tbl_job SET status = "FAILED", errorMessage = ?, completedAt = ? WHERE id = ?',
            [errorMsg, new Date(), jobId]
          );
        } catch (dbErr) {
          logger.error({ jobId, dbErr }, 'Failed to update job status to FAILED in DB');
        }
        await deleteFromS3(inputFiles).catch((cleanupErr) =>
          logger.warn({ jobId, cleanupErr }, 'Failed to purge inputs of failed job')
        );
        await moveToDeadLetter(job.data, errorMsg, job.attemptsMade + 1);
      }
      throw err;
    }
  });
}
