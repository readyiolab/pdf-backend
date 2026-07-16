import { Job } from 'bullmq';
import { JobPayload } from '../../../shared/types';
import { logger } from '../lib/logger';
import { getPool } from '../lib/mysql';
import { env } from '../config/env';
import { scanFile } from '../lib/clamav';
import { downloadFromS3, cleanupLocalFile, deleteFromS3 } from '../storage/s3';
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

  for (const key of inputFiles) {
    let localPath = '';
    try {
      localPath = await downloadFromS3(key);
      const result = await scanFile(localPath);
      if (!result.clean) {
        logger.warn({ jobId, key, signature: result.signature }, 'Malware detected in upload');
        throw new Error('Uploaded file failed the security scan and was rejected.');
      }
    } finally {
      if (localPath) cleanupLocalFile(localPath);
    }
  }
}

export async function jobRouter(job: Job<JobPayload>): Promise<void> {
  const { jobId, tool, inputFiles, options } = job.data;
  const pool = getPool();

  logger.info({ jobId, tool }, 'Worker: Starting processing job');

  // 1. Update job status to PROCESSING in MySQL -> tbl_job
  try {
    await pool.query('UPDATE tbl_job SET status = "PROCESSING" WHERE id = ?', [jobId]);
  } catch (dbErr) {
    logger.error({ jobId, dbErr }, 'Failed to update job status to PROCESSING in DB');
  }

  try {
    await job.updateProgress(5);

    // 1b. Security scan (gated) before any parsing.
    await scanInputs(jobId, inputFiles);
    await job.updateProgress(20);

    let result: { outputFileKey: string };

    // 2. Delegate to correct processor based on tool name
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
    logger.info({ jobId, tool, outputFileKey: result.outputFileKey }, 'Worker: Job completed successfully');

    // 3. Update status to COMPLETED -> tbl_job
    await pool.query(
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
      // 4. Terminal failure — record it and immediately purge the inputs so we
      //    don't wait for the scheduled sweep to reclaim storage.
      try {
        await pool.query(
          'UPDATE tbl_job SET status = "FAILED", errorMessage = ?, completedAt = ? WHERE id = ?',
          [errorMsg, new Date(), jobId]
        );
      } catch (dbErr) {
        logger.error({ jobId, dbErr }, 'Failed to update job status to FAILED in DB');
      }
      await deleteFromS3(inputFiles).catch((cleanupErr) =>
        logger.warn({ jobId, cleanupErr }, 'Failed to purge inputs of failed job')
      );
      // Preserve full context in the dead-letter queue for inspection/replay.
      await moveToDeadLetter(job.data, errorMsg, job.attemptsMade + 1);
    }
    // Re-throw so BullMQ can retry (until attempts are exhausted).
    throw err;
  }
}
