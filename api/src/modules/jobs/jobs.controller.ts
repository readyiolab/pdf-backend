import { Request, Response, NextFunction } from 'express';
import { jobsService } from './jobs.service';

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
};
