import { Request, Response, NextFunction } from 'express';
import { jobsService } from './jobs.service';
import { verifyToken, isTokenRevoked } from '../../lib/jwt';
import { subscribeJob } from '../../lib/queueEvents';

export const jobsController = {
  async createJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const job = await jobsService.createJob(userId, req.body);
      
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  },

  async getJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const { jobId } = req.params;
      const job = await jobsService.getJobById(jobId, userId);

      res.status(200).json({ job });
    } catch (err) {
      next(err);
    }
  },

  async downloadJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const { jobId } = req.params;
      const result = await jobsService.getDownloadUrl(jobId, userId);

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  /**
   * Server-Sent Events stream of live job progress. Pushes updates instead of
   * the client polling. EventSource can't send an Authorization header, so the
   * token is passed as a query param and verified here (send only over HTTPS).
   */
  async streamJob(req: Request, res: Response) {
    const token = String(req.query.token || '');
    const { jobId } = req.params;

    // Authenticate via query token before opening the stream.
    let userId: string;
    try {
      const decoded = verifyToken(token);
      if (decoded.jti && (await isTokenRevoked(decoded.jti))) {
        res.status(401).json({ status: 'error', message: 'Session logged out' });
        return;
      }
      userId = decoded.userId;
    } catch {
      res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
      return;
    }

    // Verify the caller owns the job and get its current state.
    let job;
    try {
      job = await jobsService.getJobById(jobId, userId);
    } catch (err: any) {
      res.status(err?.statusCode || 404).json({
        status: 'error',
        message: err?.message || 'Job not found',
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Emit current state immediately.
    send('status', { status: job.status, progress: statusToProgress(job.status) });

    // If the job is already terminal, finish right away.
    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      send('done', { status: job.status, errorMessage: job.errorMessage ?? null });
      res.end();
      return;
    }

    let unsubscribe = () => {};
    const finish = async (status: 'COMPLETED' | 'FAILED') => {
      try {
        const fresh = await jobsService.getJobById(jobId, userId);
        send('done', { status, errorMessage: fresh.errorMessage ?? null });
      } catch {
        send('done', { status, errorMessage: null });
      }
      cleanup();
      res.end();
    };

    unsubscribe = subscribeJob(jobId, {
      onProgress: (p) => send('progress', { progress: typeof p === 'number' ? p : 0 }),
      onCompleted: () => void finish('COMPLETED'),
      onFailed: () => void finish('FAILED'),
    });

    // Heartbeat so proxies keep the connection open.
    const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
    // Safety cap: never hold a stream open indefinitely.
    const maxLife = setTimeout(() => {
      send('timeout', {});
      cleanup();
      res.end();
    }, 10 * 60 * 1000);

    function cleanup() {
      clearInterval(heartbeat);
      clearTimeout(maxLife);
      unsubscribe();
    }

    req.on('close', cleanup);
  },
};

function statusToProgress(status: string): number {
  switch (status) {
    case 'QUEUED':
      return 0;
    case 'PROCESSING':
      return 20;
    case 'COMPLETED':
      return 100;
    default:
      return 0;
  }
}
