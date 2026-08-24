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

  async getPresignedUrlBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId, plan } = req.user;
      const result = await uploadService.generatePresignedUrlBatch(userId, plan, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async initMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId, plan } = req.user;
      const result = await uploadService.initMultipart(userId, plan, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async presignMultipartParts(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const result = await uploadService.presignMultipartParts(userId, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async completeMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const result = await uploadService.completeMultipart(userId, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async abortMultipart(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      await uploadService.abortMultipart(userId, req.body);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
};
