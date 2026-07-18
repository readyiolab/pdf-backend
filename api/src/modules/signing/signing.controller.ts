import { Request, Response, NextFunction } from 'express';
import { signingService } from './signing.service';
import { auditService } from './audit.service';
import { sendService } from './send.service';
import { getPool } from '../../lib/mysql';

/** The sender's display name, as recipients will see it in the invitation. */
async function getSenderName(userId: string): Promise<string> {
  const [rows]: any = await getPool().query('SELECT name, email FROM tbl_user WHERE id = ?', [userId]);
  return rows[0]?.name || rows[0]?.email || 'A sender';
}

export const signingController = {
  async presignUpload(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.presignUpload(req.user.id, req.body));
    } catch (err) {
      next(err);
    }
  },

  async createDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const doc = await signingService.createDocument(req.user.id, req.body);
      await auditService.record(req, {
        documentId: doc.id,
        action: 'DOCUMENT_CREATED',
        actorId: req.user.id,
        detail: `Document "${doc.title}" uploaded`,
        metadata: { fileName: doc.fileName, fileSize: doc.fileSize },
      });
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  },

  async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.listDocuments(req.user.id, req.query as any));
    } catch (err) {
      next(err);
    }
  },

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.getStats(req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async getDocument(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.getDocument(req.params.id, req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async getViewUrl(req: Request, res: Response, next: NextFunction) {
    try {
      // Already coerced to a number (or undefined) by documentVersionSchema.
      const { version } = req.query as { version?: number };
      res.status(200).json(await signingService.getViewUrl(req.params.id, req.user.id, version));
    } catch (err) {
      next(err);
    }
  },

  async updateDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const doc = await signingService.updateDocument(req.params.id, req.user.id, req.body);
      await auditService.record(req, {
        documentId: doc.id,
        action: 'DOCUMENT_UPDATED',
        actorId: req.user.id,
        detail: `Updated ${Object.keys(req.body).join(', ')}`,
      });
      res.status(200).json(doc);
    } catch (err) {
      next(err);
    }
  },

  async deleteDocument(req: Request, res: Response, next: NextFunction) {
    try {
      // Recorded BEFORE the delete: the audit rows cascade away with the
      // document, so writing after would insert against a missing FK and fail.
      // The entry still matters for anything tailing the log downstream.
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'DOCUMENT_DELETED',
        actorId: req.user.id,
      });
      res.status(200).json(await signingService.deleteDocument(req.params.id, req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async addRecipient(req: Request, res: Response, next: NextFunction) {
    try {
      const recipient = await signingService.addRecipient(req.params.id, req.user.id, req.body);
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'RECIPIENT_ADDED',
        recipientId: recipient.id,
        actorId: req.user.id,
        detail: `${recipient.name} <${recipient.email}> added as ${recipient.role}`,
      });
      res.status(201).json(recipient);
    } catch (err) {
      next(err);
    }
  },

  async updateRecipient(req: Request, res: Response, next: NextFunction) {
    try {
      const recipient = await signingService.updateRecipient(
        req.params.id,
        req.params.recipientId,
        req.user.id,
        req.body
      );
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'RECIPIENT_UPDATED',
        recipientId: recipient.id,
        actorId: req.user.id,
        detail: `Updated ${Object.keys(req.body).join(', ')} for ${recipient.email}`,
      });
      res.status(200).json(recipient);
    } catch (err) {
      next(err);
    }
  },

  async removeRecipient(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await signingService.removeRecipient(
        req.params.id,
        req.params.recipientId,
        req.user.id
      );
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'RECIPIENT_REMOVED',
        recipientId: req.params.recipientId,
        actorId: req.user.id,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async saveFields(req: Request, res: Response, next: NextFunction) {
    try {
      const fields = await signingService.saveFields(req.params.id, req.user.id, req.body);
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'FIELDS_UPDATED',
        actorId: req.user.id,
        detail: `${fields.length} field(s) saved`,
        metadata: { fieldCount: fields.length },
      });
      res.status(200).json({ fields });
    } catch (err) {
      next(err);
    }
  },

  async send(req: Request, res: Response, next: NextFunction) {
    try {
      const senderName = await getSenderName(req.user.id);
      const result = await sendService.send(req.params.id, req.user.id, senderName);

      await auditService.record(req, {
        documentId: req.params.id,
        action: 'DOCUMENT_SENT',
        actorId: req.user.id,
        detail: `Sent to ${result.notified.length} recipient(s)`,
        metadata: { notified: result.notified.map((n) => ({ recipientId: n.recipientId, delivered: n.delivered })) },
      });

      // Per-recipient delivery is reported rather than thrown: the document IS
      // sent and the tokens ARE live even if one mailbox bounced. The sender
      // needs to know exactly who to chase, not a blanket failure.
      for (const n of result.notified.filter((n) => !n.delivered)) {
        await auditService.record(req, {
          documentId: req.params.id,
          recipientId: n.recipientId,
          action: 'EMAIL_BOUNCED',
          detail: `Delivery to ${n.email} failed: ${n.error}`,
        });
      }

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async resend(req: Request, res: Response, next: NextFunction) {
    try {
      const senderName = await getSenderName(req.user.id);
      const result = await sendService.resend(req.params.id, req.params.recipientId, req.user.id, senderName);

      await auditService.record(req, {
        documentId: req.params.id,
        recipientId: req.params.recipientId,
        action: 'REMINDER_SENT',
        actorId: req.user.id,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  /** Per-signer progress for the sender's tracker. */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.getStatus(req.params.id, req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async getDownloadUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { version } = req.query as { version?: number };
      const result = await signingService.getDownloadUrl(req.params.id, req.user.id, version);
      await auditService.record(req, {
        documentId: req.params.id,
        action: 'DOCUMENT_DOWNLOADED',
        actorId: req.user.id,
        metadata: { version: version ?? 'latest' },
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getCertificateUrl(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await signingService.getCertificateUrl(req.params.id, req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async getAudit(req: Request, res: Response, next: NextFunction) {
    try {
      await signingService.assertOwnership(req.params.id, req.user.id);
      const { page, limit } = req.query as any;
      res.status(200).json(await auditService.list(req.params.id, page, limit));
    } catch (err) {
      next(err);
    }
  },
};
