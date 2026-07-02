import { Request, Response, NextFunction } from 'express';
import { uploadService } from './upload.service';

export const uploadController = {
  async getPresignedUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId, plan } = req.user;
      const result = await uploadService.generatePresignedUrl(userId, plan, req.body);
      
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
