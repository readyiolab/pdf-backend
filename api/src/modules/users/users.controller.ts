import { Request, Response, NextFunction } from 'express';
import { usersService } from './users.service';

export const usersController = {
  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId } = req.user;
      const profile = await usersService.getUserProfile(userId);
      
      res.status(200).json({ user: profile });
    } catch (err) {
      next(err);
    }
  },
};
