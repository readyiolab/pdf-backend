import { Request, Response, NextFunction } from 'express';
import { healthService } from './health.service';

export const healthController = {
  async getHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await healthService.checkHealth();
      const statusCode = report.status === 'UP' ? 200 : 503;
      res.status(statusCode).json(report);
    } catch (err) {
      next(err);
    }
  },
};
