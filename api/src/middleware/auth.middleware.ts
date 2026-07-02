import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { getPool } from '../lib/mysql';
import { AppError } from './errorHandler.middleware';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        plan: 'FREE' | 'PRO';
      };
    }
  }
}

interface JWTPayload {
  userId: string;
  email: string;
  plan: 'FREE' | 'PRO';
}

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authorization token is missing or malformed', 401);
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token
    let decoded: JWTPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    } catch (err) {
      throw new AppError('Invalid or expired authentication token', 401);
    }

    // Check if user still exists in the database
    const pool = getPool();
    const [users]: any = await pool.query('SELECT id, plan FROM tbl_user WHERE id = ?', [decoded.userId]);
    const user = users[0];

    if (!user) {
      throw new AppError('The user belonging to this token no longer exists', 401);
    }

    // Attach user to request
    req.user = {
      id: user.id,
      plan: user.plan as 'FREE' | 'PRO',
    };

    next();
  } catch (err) {
    next(err);
  }
};
