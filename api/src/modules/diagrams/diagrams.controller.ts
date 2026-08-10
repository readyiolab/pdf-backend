import { Request, Response, NextFunction } from 'express';
import { diagramsService } from './diagrams.service';
import { diagramAiService } from './diagramAi.service';

export const diagramsController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const folderId =
        typeof req.query.folderId === 'string' ? req.query.folderId : undefined;
      const diagrams = await diagramsService.list(
        req.orgContext!.organizationId,
        folderId
      );
      res.json({ diagrams });
    } catch (e) {
      next(e);
    }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.get(
        req.orgContext!.organizationId,
        req.params.id
      );
      res.json({ diagram });
    } catch (e) {
      next(e);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.create(
        req.orgContext!.organizationId,
        req.user.id,
        req.body
      );
      res.status(201).json({ diagram });
    } catch (e) {
      next(e);
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.update(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id,
        req.body
      );
      res.json({ diagram });
    } catch (e) {
      next(e);
    }
  },

  async duplicate(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.duplicate(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id
      );
      res.status(201).json({ diagram });
    } catch (e) {
      next(e);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await diagramsService.remove(req.orgContext!.organizationId, req.params.id)
      );
    } catch (e) {
      next(e);
    }
  },

  async listVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const versions = await diagramsService.listVersions(
        req.orgContext!.organizationId,
        req.params.id
      );
      res.json({ versions });
    } catch (e) {
      next(e);
    }
  },

  async restoreVersion(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.restoreVersion(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id,
        Number(req.params.version)
      );
      res.json({ diagram });
    } catch (e) {
      next(e);
    }
  },

  async listFolders(req: Request, res: Response, next: NextFunction) {
    try {
      const folders = await diagramsService.listFolders(req.orgContext!.organizationId);
      res.json({ folders });
    } catch (e) {
      next(e);
    }
  },

  async createFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const folder = await diagramsService.createFolder(
        req.orgContext!.organizationId,
        req.user.id,
        req.body.name
      );
      res.status(201).json({ folder });
    } catch (e) {
      next(e);
    }
  },

  async renameFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const folder = await diagramsService.renameFolder(
        req.orgContext!.organizationId,
        req.params.id,
        req.body.name
      );
      res.json({ folder });
    } catch (e) {
      next(e);
    }
  },

  async deleteFolder(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await diagramsService.deleteFolder(
          req.orgContext!.organizationId,
          req.params.id
        )
      );
    } catch (e) {
      next(e);
    }
  },

  async createShare(req: Request, res: Response, next: NextFunction) {
    try {
      const share = await diagramsService.createShare(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id,
        req.body
      );
      res.status(201).json({ share });
    } catch (e) {
      next(e);
    }
  },

  async listShares(req: Request, res: Response, next: NextFunction) {
    try {
      const shares = await diagramsService.listShares(
        req.orgContext!.organizationId,
        req.params.id
      );
      res.json({ shares });
    } catch (e) {
      next(e);
    }
  },

  async revokeShare(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await diagramsService.revokeShare(
          req.orgContext!.organizationId,
          req.params.shareId
        )
      );
    } catch (e) {
      next(e);
    }
  },

  async aiGenerate(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await diagramAiService.generate(req.user.id, req.user.plan, req.body.prompt)
      );
    } catch (e) {
      next(e);
    }
  },

  async aiEdit(req: Request, res: Response, next: NextFunction) {
    try {
      // Ensure diagram exists in org (authz); AI edit itself is page-local.
      await diagramsService.get(req.orgContext!.organizationId, req.params.id);
      res.json(
        await diagramAiService.edit(
          req.user.id,
          req.user.plan,
          req.body.instruction,
          req.body.page
        )
      );
    } catch (e) {
      next(e);
    }
  },

  async aiFromImage(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await diagramAiService.fromImage(
          req.user.id,
          req.user.plan,
          req.body.imageBase64,
          req.body.mimeType,
          req.body.prompt
        )
      );
    } catch (e) {
      next(e);
    }
  },

  async getShared(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await diagramsService.getByShareToken(req.params.token));
    } catch (e) {
      next(e);
    }
  },

  async updateShared(req: Request, res: Response, next: NextFunction) {
    try {
      const diagram = await diagramsService.updateByShareToken(req.params.token, req.body);
      res.json({ diagram });
    } catch (e) {
      next(e);
    }
  },
};
