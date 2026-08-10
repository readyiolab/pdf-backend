import { Request, Response, NextFunction } from 'express';
import { brandService, templateService } from './brandTemplate.service';
import { batchService } from './batch.service';
import { generateService } from './generate.service';
import { sendService, mailAccountService } from './send.service';
import { historyService } from './history.service';
import { letterAiService } from './letterAi.service';
import { orgsService } from '../orgs/orgs.service';
import { getStorageForUser } from '../../lib/storage';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import crypto from 'crypto';

async function ensureOrg(req: Request) {
  if (!req.orgContext) {
    await orgsService.createOrg(req.user.id);
  }
}

export const lettersController = {
  // --- Brands ---
  async listBrands(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await brandService.list(req.orgContext!.organizationId);
      res.json({ brands: rows });
    } catch (e) {
      next(e);
    }
  },
  async createBrand(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await brandService.create(
        req.orgContext!.organizationId,
        req.user.id,
        req.body
      );
      res.status(201).json({ brand: row });
    } catch (e) {
      next(e);
    }
  },
  async updateBrand(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await brandService.update(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id,
        req.body
      );
      res.json({ brand: row });
    } catch (e) {
      next(e);
    }
  },
  async deleteBrand(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await brandService.remove(req.orgContext!.organizationId, req.user.id, req.params.id)
      );
    } catch (e) {
      next(e);
    }
  },

  // --- Templates ---
  async listTemplates(req: Request, res: Response, next: NextFunction) {
    try {
      const templates = await templateService.list(req.orgContext!.organizationId);
      res.json({ templates });
    } catch (e) {
      next(e);
    }
  },
  async seedTemplates(req: Request, res: Response, next: NextFunction) {
    try {
      const overwrite = Boolean(req.body?.overwrite);
      const result = overwrite
        ? await templateService.refreshStarters(
            req.orgContext!.organizationId,
            req.user.id,
            true
          )
        : await templateService.ensureStarters(
            req.orgContext!.organizationId,
            req.user.id
          );
      // If library already has templates but starters are missing, fill gaps without overwrite
      if (!overwrite && result.seeded === 0) {
        const refreshed = await templateService.refreshStarters(
          req.orgContext!.organizationId,
          req.user.id,
          false
        );
        res.json(refreshed);
        return;
      }
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
  async getTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const template = await templateService.get(
        req.orgContext!.organizationId,
        req.params.id
      );
      res.json({ template });
    } catch (e) {
      next(e);
    }
  },
  async createTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const template = await templateService.create(
        req.orgContext!.organizationId,
        req.user.id,
        req.body
      );
      // Fire-and-forget embed for RAG
      letterAiService
        .embedTemplate(
          req.orgContext!.organizationId,
          template.id,
          JSON.stringify(template.contentJson)
        )
        .catch(() => undefined);
      res.status(201).json({ template });
    } catch (e) {
      next(e);
    }
  },
  async updateTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const template = await templateService.update(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.id,
        req.body
      );
      letterAiService
        .embedTemplate(
          req.orgContext!.organizationId,
          template.id,
          JSON.stringify(template.contentJson)
        )
        .catch(() => undefined);
      res.json({ template });
    } catch (e) {
      next(e);
    }
  },
  async deleteTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await templateService.remove(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.id
        )
      );
    } catch (e) {
      next(e);
    }
  },

  // --- Batches / import ---
  async listBatches(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ batches: await historyService.listBatches(req.orgContext!.organizationId) });
    } catch (e) {
      next(e);
    }
  },
  async createBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const batch = await batchService.create(req.orgContext!.organizationId, req.user.id, {
        templateId: req.body.templateId,
        brandProfileId: req.body.brandProfileId,
      });
      res.status(201).json({ batch });
    } catch (e) {
      next(e);
    }
  },
  async getBatch(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await historyService.getBatchDetail(req.orgContext!.organizationId, req.params.batchId)
      );
    } catch (e) {
      next(e);
    }
  },
  async parseUpload(req: Request, res: Response, next: NextFunction) {
    try {
      // Client uploads to Spaces first, then posts fileKey; OR posts base64 for small files
      if (req.body.fileBase64) {
        const buffer = Buffer.from(req.body.fileBase64, 'base64');
        const parsed = batchService.parseWorkbook(buffer);
        const batch = await batchService.attachSource(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId,
          {
            sourceFileKey: req.body.sourceFileKey || 'inline',
            sourceFileName: req.body.sourceFileName || 'upload.xlsx',
            headers: parsed.headers,
            preview: parsed.preview,
          }
        );
        // Stash rows in memory is not durable — require map with rows in next call for inline
        res.json({
          batch,
          headers: parsed.headers,
          preview: parsed.preview,
          totalRows: parsed.totalRows,
          rows: parsed.rows,
          systemFields: batchService.systemFields,
        });
        return;
      }

      if (!req.body.sourceFileKey) {
        throw new AppError('sourceFileKey or fileBase64 is required', 400);
      }

      const { storage } = await getStorageForUser(req.user.id);
      let buffer: Buffer;
      if (typeof (storage as any).getObjectBytes === 'function') {
        buffer = await storage.getObjectBytes(req.body.sourceFileKey);
      } else {
        const url = await storage.presignGet(req.body.sourceFileKey, {
          ttlSeconds: env.DOWNLOAD_URL_TTL,
        });
        const resp = await fetch(url);
        if (!resp.ok) throw new AppError('Failed to download uploaded spreadsheet', 500);
        buffer = Buffer.from(await resp.arrayBuffer());
      }

      const parsed = batchService.parseWorkbook(buffer);
      const batch = await batchService.attachSource(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.batchId,
        {
          sourceFileKey: req.body.sourceFileKey,
          sourceFileName: req.body.sourceFileName || 'upload.xlsx',
          headers: parsed.headers,
          preview: parsed.preview,
        }
      );
      res.json({
        batch,
        headers: parsed.headers,
        preview: parsed.preview,
        totalRows: parsed.totalRows,
        rows: parsed.rows,
        systemFields: batchService.systemFields,
      });
    } catch (e) {
      next(e);
    }
  },
  async applyMapping(req: Request, res: Response, next: NextFunction) {
    try {
      if (!Array.isArray(req.body.rows)) {
        throw new AppError('rows array is required', 400);
      }
      const result = await batchService.applyMappingAndRows(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.batchId,
        req.user.plan,
        req.body.mapping || {},
        req.body.rows
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
  async validateBatch(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await batchService.validate(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId,
          { sendModeSelected: Boolean(req.body?.sendModeSelected) }
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async validationIssues(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        issues: await batchService.validationIssues(
          req.orgContext!.organizationId,
          req.params.batchId
        ),
      });
    } catch (e) {
      next(e);
    }
  },
  async listEmployees(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        employees: await batchService.listEmployees(
          req.orgContext!.organizationId,
          req.params.batchId,
          {
            validationStatus: req.query.validationStatus as string | undefined,
            sendStatus: req.query.sendStatus as string | undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            offset: req.query.offset ? Number(req.query.offset) : undefined,
          }
        ),
      });
    } catch (e) {
      next(e);
    }
  },

  // --- Generate ---
  async samplePreview(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await generateService.samplePreview(req.orgContext!.organizationId, req.params.batchId)
      );
    } catch (e) {
      next(e);
    }
  },
  async approveGenerate(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.body.approved !== true) {
        throw new AppError('You must set approved=true after reviewing a sample', 400);
      }
      res.json(
        await generateService.approveAndEnqueue(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId,
          req.body.passwordMode || 'NONE'
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async generateProgress(req: Request, res: Response, next: NextFunction) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        await generateService.progress(req.orgContext!.organizationId, req.params.batchId)
      );
    } catch (e) {
      next(e);
    }
  },

  // --- Send / mail ---
  async listMailAccounts(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ accounts: await mailAccountService.list(req.user.id) });
    } catch (e) {
      next(e);
    }
  },
  async mailAuthorize(req: Request, res: Response, next: NextFunction) {
    try {
      const provider = String(req.query.provider || '').toUpperCase();
      if (provider !== 'OUTLOOK' && provider !== 'GMAIL') {
        throw new AppError('provider must be OUTLOOK or GMAIL', 400);
      }
      const nonce = cryptoRandom();
      const url = await mailAccountService.getAuthorizeUrl(provider, req.user.id, nonce);
      res.json({ url });
    } catch (e) {
      next(e);
    }
  },
  async mailExchange(req: Request, res: Response, next: NextFunction) {
    try {
      const account = await mailAccountService.exchangeOAuthCode(
        req.user.id,
        String(req.body.code || ''),
        String(req.body.state || '')
      );
      res.json({ account });
    } catch (e) {
      next(e);
    }
  },
  async disconnectMailAccount(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await mailAccountService.disconnect(req.user.id, req.params.id));
    } catch (e) {
      next(e);
    }
  },
  async startSend(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await sendService.startSend(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.params.batchId,
          req.body
        )
      );
    } catch (e) {
      next(e);
    }
  },

  // --- History / audit ---
  async audit(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        audit: await historyService.listAudit(req.orgContext!.organizationId),
      });
    } catch (e) {
      next(e);
    }
  },
  async report(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        report: await historyService.downloadReport(
          req.orgContext!.organizationId,
          req.params.batchId
        ),
      });
    } catch (e) {
      next(e);
    }
  },
  async downloadPdfsZip(req: Request, res: Response, next: NextFunction) {
    try {
      await historyService.streamPdfsZip(
        req.orgContext!.organizationId,
        req.user.id,
        req.params.batchId,
        res
      );
    } catch (e) {
      next(e);
    }
  },
  async employeePdfUrl(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await historyService.presignEmployeePdf(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId,
          req.params.employeeId
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async retryFailedGenerate(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await generateService.retryFailedOnly(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId
        )
      );
    } catch (e) {
      next(e);
    }
  },

  // --- AI (suggestions only) ---
  async aiDraft(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.draft(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.body
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiApplyDraft(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.applyDraft(
          req.orgContext!.organizationId,
          req.user.id,
          req.body.templateId || null,
          req.body.contentJson,
          req.body.name,
          req.body.type
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiPolish(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.polish(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.body
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiSuggestMapping(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.suggestMapping(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.body.headers || []
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiAnomalies(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.detectAnomalies(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiSummary(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.batchSummary(
          req.orgContext!.organizationId,
          req.user.id,
          req.params.batchId
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiQuery(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.naturalLanguageQuery(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.body.question
        )
      );
    } catch (e) {
      next(e);
    }
  },
  async aiSuggestTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(
        await letterAiService.suggestTemplate(
          req.orgContext!.organizationId,
          req.user.id,
          req.user.plan,
          req.body.letterType
        )
      );
    } catch (e) {
      next(e);
    }
  },

  async bootstrap(req: Request, res: Response, next: NextFunction) {
    try {
      const org = await orgsService.createOrg(req.user.id);
      if (!org.organization?.id) {
        throw new AppError('Organization could not be created', 500);
      }
      req.orgContext = {
        organizationId: org.organization.id,
        role: org.role as any,
        membershipId: org.membershipId,
        orgName: org.organization.name,
      };
      let starters = { seeded: 0, templates: [] as any[] };
      let warning: string | undefined;
      try {
        starters = await templateService.ensureStarters(
          req.orgContext.organizationId,
          req.user.id
        );
      } catch (err) {
        const e = err as { sqlMessage?: string; message?: string; code?: string };
        warning =
          e.sqlMessage ||
          e.message ||
          'Starter templates could not be seeded — check letter schema DDL on API boot.';
      }
      res.json({ org, starters, warning });
    } catch (e) {
      next(e);
    }
  },
};

function cryptoRandom() {
  return crypto.randomBytes(8).toString('hex');
}
