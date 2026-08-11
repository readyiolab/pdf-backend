import { Request, Response, NextFunction } from 'express';
import { healthService } from './health.service';

export const healthController = {
  async getLive(_req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(healthService.checkLive());
    } catch (err) {
      next(err);
    }
  },

  async getReady(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await healthService.checkReady();
      const statusCode = report.status === 'UP' ? 200 : 503;
      res.status(statusCode).json(report);
    } catch (err) {
      next(err);
    }
  },

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
