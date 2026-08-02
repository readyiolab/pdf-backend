import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { adminService } from './admin.service';

export const adminController = {
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(1),
        })
        .parse(req.body);
      const data = await adminService.login(body.email, body.password);
      res.json(data);
    } catch (err) {
      next(err);
    }
  },

  async dashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.dashboard();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async listOrganizations(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.listOrganizations();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getOrganization(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await adminService.getOrganization(
        req.params.id,
        req.user?.id,
        req.ip ?? null
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getAudit(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit) || 50;
      const data = await adminService.getAudit(
        req.params.id,
        limit,
        req.user?.id,
        req.ip ?? null
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async patchOrganization(req: Request, res: Response, next: NextFunction) {
    try {
      const body = z
        .object({
          status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
          plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
          licenseKey: z.string().max(255).nullable().optional(),
          name: z.string().min(1).max(200).optional(),
        })
        .parse(req.body);
      const data = await adminService.patchOrganization(
        req.params.id,
        body,
        req.user?.id,
        req.ip ?? null
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async provision(req: Request, res: Response, next: NextFunction) {
    try {
      const body = z
        .object({
          ownerEmail: z.string().email(),
          name: z.string().min(1).max(200).optional(),
          licenseKey: z.string().max(255).optional(),
        })
        .parse(req.body);
      const data = await adminService.provisionEnterprise(
        body,
        req.user?.id,
        req.ip ?? null
      );
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
};
