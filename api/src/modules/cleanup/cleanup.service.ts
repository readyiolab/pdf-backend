import { deleteObjects } from '../../lib/s3';
import { db } from '../../lib/mysql';
import { logger } from '../../lib/logger';

const CLEANUP_BATCH_SIZE = 200;

export const cleanupService = {
  async cleanupExpiredJobs() {
    logger.info('Starting scheduled cleanup of expired jobs and storage objects...');
    const now = new Date();

    try {
      let totalDeletedJobs = 0;
      let totalDeletedObjects = 0;

      for (;;) {
        const expiredJobs = await db.selectAll(
          'tbl_job',
          'id, inputFiles, outputFile, storageBindingId',
          'expiresAt < ?',
          [now],
          `ORDER BY expiresAt ASC LIMIT ${CLEANUP_BATCH_SIZE}`
        );

        if (expiredJobs.length === 0) {
          break;
        }

        logger.info({ count: expiredJobs.length }, 'Found expired jobs to clean up');

        const byBinding = new Map<string | null, string[]>();
        for (const job of expiredJobs) {
          const keys: string[] = [];
          try {
            if (job.inputFiles) {
              const inputFiles: string[] =
                typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
              if (Array.isArray(inputFiles)) keys.push(...inputFiles);
            }
          } catch {
            // ignore
          }
          if (job.outputFile) keys.push(job.outputFile);
          const bid = (job.storageBindingId as string) || null;
          const list = byBinding.get(bid) ?? [];
          list.push(...keys);
          byBinding.set(bid, list);
        }

        for (const [bindingId, keys] of byBinding) {
          await deleteObjects(keys, bindingId);
          totalDeletedObjects += keys.length;
        }

        const expiredJobIds = expiredJobs.map((j: any) => j.id);
        const placeholders = expiredJobIds.map(() => '?').join(',');
        const deleteResult = await db.execute(
          `DELETE FROM tbl_job WHERE id IN (${placeholders})`,
          expiredJobIds
        );
        totalDeletedJobs += deleteResult.affectedRows;

        if (expiredJobs.length < CLEANUP_BATCH_SIZE) break;
      }

      if (totalDeletedJobs === 0) {
        logger.info('No expired jobs found.');
        return;
      }

      logger.info(
        { deletedJobs: totalDeletedJobs, deletedObjects: totalDeletedObjects },
        'Cleanup complete: removed expired job rows'
      );
    } catch (err) {
      logger.error({ err }, 'Cleanup sweep failed');
      throw err;
    }
  },
};
