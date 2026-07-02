import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { s3 } from '../../lib/s3';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export const cleanupService = {
  async cleanupExpiredJobs() {
    logger.info('Starting scheduled cleanup of expired jobs and S3 objects...');
    const now = new Date();
    const pool = getPool();

    try {
      // 1. Find jobs that have expired -> tbl_job
      const [expiredJobs]: any = await pool.query(
        'SELECT id, inputFiles, outputFile FROM tbl_job WHERE expiresAt < ?',
        [now]
      );

      if (expiredJobs.length === 0) {
        logger.info('No expired jobs found.');
        return;
      }

      logger.info({ count: expiredJobs.length }, 'Found expired jobs to clean up');

      // 2. Compile list of S3 object keys to delete
      const objectsToDelete: { Key: string }[] = [];

      for (const job of expiredJobs) {
        try {
          if (job.inputFiles) {
            const inputFiles: string[] = typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
            if (Array.isArray(inputFiles)) {
              inputFiles.forEach((key) => {
                objectsToDelete.push({ Key: key });
              });
            }
          }
        } catch (e) {
          // ignore parsing error
        }

        if (job.outputFile) {
          objectsToDelete.push({ Key: job.outputFile });
        }
      }

      // 3. Batch delete files from S3
      const chunkSize = 1000;
      for (let i = 0; i < objectsToDelete.length; i += chunkSize) {
        const chunk = objectsToDelete.slice(i, i + chunkSize);
        
        try {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: env.DO_SPACES_BUCKET,
              Delete: {
                Objects: chunk,
                Quiet: true,
              },
            })
          );
          logger.info({ deletedCount: chunk.length }, 'Deleted batch of files from S3');
        } catch (s3Err) {
          logger.error({ s3Err }, 'Failed to delete file batch from S3');
        }
      }

      // 4. Delete corresponding job rows from MySQL -> tbl_job
      const expiredJobIds = expiredJobs.map((j: any) => j.id);
      
      const [deleteResult]: any = await pool.query(
        'DELETE FROM tbl_job WHERE id IN (?)',
        [expiredJobIds]
      );

      logger.info(
        { deletedJobsCount: deleteResult.affectedRows },
        'Pruned expired jobs from database completed'
      );
    } catch (err) {
      logger.error({ err }, 'Error during cleanup task execution');
    }
  },
};
