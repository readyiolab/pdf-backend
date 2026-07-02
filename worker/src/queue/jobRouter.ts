import { Job } from 'bullmq';
import { JobPayload } from '../../../shared/types';
import { logger } from '../lib/logger';
import { getPool } from '../lib/mysql';

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

    logger.info({ jobId, tool, outputFileKey: result.outputFileKey }, 'Worker: Job completed successfully');
    
    // 3. Update status to COMPLETED -> tbl_job
    await pool.query(
      'UPDATE tbl_job SET status = "COMPLETED", completedAt = ?, outputFile = ? WHERE id = ?',
      [new Date(), result.outputFileKey, jobId]
    );
  } catch (err: any) {
    const errorMsg = err.message || 'Unknown processing error';
    logger.error({ jobId, tool, err }, 'Worker: Job failed during processing');
    
    // 4. Update status to FAILED -> tbl_job
    try {
      await pool.query(
        'UPDATE tbl_job SET status = "FAILED", errorMessage = ?, completedAt = ? WHERE id = ?',
        [errorMsg, new Date(), jobId]
      );
    } catch (dbErr) {
      logger.error({ jobId, dbErr }, 'Failed to update job status to FAILED in DB');
    }
    
    throw err;
  }
}
