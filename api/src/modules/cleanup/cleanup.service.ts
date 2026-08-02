import { deleteObjects } from '../../lib/s3';
import { db } from '../../lib/mysql';
import { logger } from '../../lib/logger';

export const cleanupService = {
  async cleanupExpiredJobs() {
    logger.info('Starting scheduled cleanup of expired jobs and storage objects...');
    const now = new Date();

    try {
      const expiredJobs = await db.selectAll(
        'tbl_job',
        'id, inputFiles, outputFile, storageBindingId',
        'expiresAt < ?',
        [now]
      );

      if (expiredJobs.length === 0) {
        logger.info('No expired jobs found.');
        return;
      }

      logger.info({ count: expiredJobs.length }, 'Found expired jobs to clean up');

      // Group keys by binding so provider switches don't orphan deletes
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

      let deletedCount = 0;
      for (const [bindingId, keys] of byBinding) {
        await deleteObjects(keys, bindingId);
        deletedCount += keys.length;
      }
      logger.info({ deletedCount }, 'Deleted expired job files from storage');

      const expiredJobIds = expiredJobs.map((j: any) => j.id);
      const placeholders = expiredJobIds.map(() => '?').join(',');
      const deleteResult = await db.execute(
        `DELETE FROM tbl_job WHERE id IN (${placeholders})`,
        expiredJobIds
      );

      logger.info(
        { deletedJobs: deleteResult.affectedRows },
        'Cleanup complete: removed expired job rows'
      );
    } catch (err) {
      logger.error({ err }, 'Cleanup sweep failed');
      throw err;
    }
  },
};
