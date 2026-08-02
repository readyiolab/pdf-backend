import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { enterpriseService } from './enterprise.service';

const providerSchema = z.enum(['PLATFORM', 'AWS_S3', 'AZURE_BLOB', 'GCS', 'R2', 'MINIO']);

const credentialsSchema = z
  .object({
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    connectionString: z.string().min(1).optional(),
    accountName: z.string().min(1).optional(),
    accountKey: z.string().min(1).optional(),
    serviceAccountJson: z.string().min(1).optional(),
  })
  .optional();

const storageBodySchema = z.object({
  provider: providerSchema,
  bucket: z.string().min(1).max(255).optional(),
  region: z.string().max(100).optional(),
  endpoint: z.string().max(512).optional(),
  credentials: credentialsSchema,
  useSavedSecrets: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
});

export const enterpriseController = {
  async getOrganization(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await enterpriseService.getOrCreateOrganization(req.user.id, req.body?.name);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getStorage(req: Request, res: Response, next: NextFunction) {
    try {
      const storage = await enterpriseService.getStorage(req.user.id);
      res.json({ success: true, data: storage });
    } catch (err) {
      next(err);
    }
  },

  async testStorage(req: Request, res: Response, next: NextFunction) {
    try {
      const body = storageBodySchema.parse(req.body);
      const result = await enterpriseService.testStorage(req.user.id, {
        provider: body.provider,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint,
        credentials: body.credentials as any,
        useSavedSecrets: body.useSavedSecrets,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  async saveStorage(req: Request, res: Response, next: NextFunction) {
    try {
      const body = storageBodySchema.parse(req.body);
      const storage = await enterpriseService.saveStorage(
        req.user.id,
        {
          provider: body.provider,
          bucket: body.bucket,
          region: body.region,
          endpoint: body.endpoint,
          credentials: body.credentials as any,
        },
        req
      );
      res.json({ success: true, data: storage });
    } catch (err) {
      next(err);
    }
  },

  async resetStorage(req: Request, res: Response, next: NextFunction) {
    try {
      const storage = await enterpriseService.resetStorage(req.user.id, req);
      res.json({ success: true, data: storage });
    } catch (err) {
      next(err);
    }
  },

  async listAudit(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit) || 50;
      const data = await enterpriseService.listAudit(req.user.id, limit);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
};
