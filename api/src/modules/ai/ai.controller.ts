import { Request, Response, NextFunction } from 'express';
import { aiService } from './ai.service';

export const aiController = {
  async presignUpload(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await aiService.presignUpload(req.user.id, req.body));
    } catch (err) {
      next(err);
    }
  },

  async summarize(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await aiService.summarize(req.user.id, req.user.plan, req.body));
    } catch (err) {
      next(err);
    }
  },

  async explain(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await aiService.explain(req.user.id, req.user.plan, req.body));
    } catch (err) {
      next(err);
    }
  },

  async chat(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await aiService.chat(req.user.id, req.user.plan, req.body));
    } catch (err) {
      next(err);
    }
  },

  async getQuota(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await aiService.getQuota(req.user.id, req.user.plan));
    } catch (err) {
      next(err);
    }
  },
};
