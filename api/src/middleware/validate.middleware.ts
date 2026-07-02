import { Request, Response, NextFunction } from 'express';
import { AnyZodObject } from 'zod';

export const validate = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      
      // Update req objects with validated & coerced values
      req.body = parsed.body;
      req.query = parsed.query;
      req.params = parsed.params;
      
      next();
    } catch (error) {
      next(error);
    }
  };
};
