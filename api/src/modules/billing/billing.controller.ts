import { Request, Response, NextFunction } from 'express';
import { billingService } from './billing.service';

export const billingController = {
  async checkout(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const result = await billingService.createCheckout(userId, req.body);
      
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const result = await billingService.getSubscriptionStatus(userId);
      
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
