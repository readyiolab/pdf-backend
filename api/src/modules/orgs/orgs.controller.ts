import { Request, Response, NextFunction } from 'express';
import { orgsService } from './orgs.service';

export const orgsController = {
  async listMine(req: Request, res: Response, next: NextFunction) {
    try {
      const orgs = await orgsService.listMyOrgs(req.user.id);
      res.json({ organizations: orgs });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.createOrg(req.user.id, req.body?.name);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  /** Ensures the caller has a personal/workspace org (auto-create). */
  async ensure(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.createOrg(req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async listMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const members = await orgsService.listMembers(req.orgContext!.organizationId);
      res.json({ members });
    } catch (err) {
      next(err);
    }
  },

  async invite(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.inviteMember(
        req.orgContext!.organizationId,
        req.user.id,
        req.body.email,
        req.body.role
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async acceptInvite(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.acceptInvite(req.user.id, req.body.token);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async changeRole(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.changeRole(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.membershipId,
        req.body.role
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async setRetention(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await orgsService.setRetentionDays(
        req.orgContext!.organizationId,
        Number(req.body.days),
        req.user.id
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
};
