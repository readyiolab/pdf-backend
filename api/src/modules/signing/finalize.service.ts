import crypto from 'crypto';
import { getObjectBytes, getSignedDownloadUrl, putObjectBytes } from '../../lib/s3';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { pdfStampService, type StampField } from './pdfStamp.service';
import { certificateService } from './certificate.service';
import { signPdf } from './digitalSignature.service';
import { auditService } from './audit.service';
import { completionEmail } from './email.templates';
import { SIGNING_LIMITS } from '../../../../shared/signing';
import { recordCustomerEvent, upsertContact } from '../../lib/customerTracking';

export const finalizeService = {
  /**
   * Produces the signed PDF once every signer is done.
   *
   * Invoked by the sign-finalize BullMQ worker (not the HTTP request). Claims
   * the document from FINALIZING → COMPLETED so retries are idempotent.
   */
  async finalize(documentId: string): Promise<{ version: number; sha256: string } | null> {
    // Claim FINALIZING → processing. The HTTP path only moves SENT → FINALIZING
    // and enqueues; this worker owns the seal. Also accept SENT as a safety net
    // for any legacy inline callers / recovery.
    const claim = await db.execute(
      `UPDATE tbl_sign_document
          SET status = 'FINALIZING', completedAt = COALESCE(completedAt, ?)
        WHERE id = ? AND status IN ('SENT', 'FINALIZING')`,
      [new Date(), documentId]
    );
    if (claim.affectedRows === 0) {
      const row = await db.select('tbl_sign_document', 'status', 'id = ?', [documentId]);
      logger.info(
        { documentId, status: row?.status },
        'Finalization skipped — document not in SENT/FINALIZING'
      );
      return null;
    }

    try {
      const doc = await db.select('tbl_sign_document', '*', 'id = ?', [documentId]);

      // Already sealed (retry after success but before removeOnComplete)?
      if (doc!.status === 'COMPLETED' && doc!.currentVersion > 1) {
        logger.info({ documentId }, 'Finalization skipped — already COMPLETED');
        return null;
      }

      const fields = await db.queryAll(
        'SELECT type, page, x, y, width, height, value, config FROM tbl_sign_field WHERE documentId = ? AND value IS NOT NULL',
        [documentId]
      );

      const stampFields: StampField[] = fields.map((f: any) => ({
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        value: f.value,
        config: typeof f.config === 'string' ? JSON.parse(f.config || '{}') : (f.config ?? {}),
      }));

      const bindingId = doc!.storageBindingId ?? null;
      const originalBytes = await getObjectBytes(doc!.fileKey, bindingId);

      const currentHash = crypto.createHash('sha256').update(originalBytes).digest('hex');
      if (doc!.originalHash && currentHash !== doc!.originalHash) {
        throw new Error(
          `Original document hash mismatch for ${documentId}: stored ${doc!.originalHash}, found ${currentHash}`
        );
      }

      const stampedBytes = await pdfStampService.stamp(originalBytes, stampFields);

      const version = (doc!.currentVersion ?? 1) + 1;
      const folder = doc!.fileKey.replace(/\/original_.*$/, '');
      const signedKey = `${folder}/signed_v${version}.pdf`;
      const certificateKey = `${folder}/certificate_v${version}.pdf`;

      const certificateBytes = await certificateService.build(documentId);
      const assembledBytes = await certificateService.appendTo(stampedBytes, certificateBytes);

      let signedBytes = assembledBytes;
      let digitallySigned = false;
      let selfSignedCert = false;
      let tsaTimestamp: Date | null = null;
      let tsaTokenKey: string | null = null;
      try {
        const result = await signPdf(assembledBytes, {
          signerName: 'PDFToolkit',
          reason: `Signed by all parties of "${doc!.title}"`,
          location: 'PDFToolkit e-Sign',
          signingTime: new Date(),
        });
        signedBytes = result.bytes;
        digitallySigned = true;
        selfSignedCert = result.selfSigned;

        if (result.timestamp) {
          tsaTimestamp = result.timestamp.timestamp;
          tsaTokenKey = `${folder}/timestamp_v${version}.tsr`;
          await putObjectBytes(
            tsaTokenKey,
            result.timestamp.token,
            'application/timestamp-reply',
            bindingId
          );
        }
      } catch (err) {
        logger.error({ err, documentId }, 'Digital signature failed; storing unsigned final document');
      }

      await putObjectBytes(signedKey, signedBytes, 'application/pdf', bindingId);
      await putObjectBytes(certificateKey, certificateBytes, 'application/pdf', bindingId);

      // Hash the bytes we just uploaded — avoid a second full Spaces download.
      const sha256 = crypto.createHash('sha256').update(signedBytes).digest('hex');

      await db.insert('tbl_sign_document_version', {
        id: crypto.randomUUID(),
        documentId,
        version,
        fileKey: signedKey,
        storageBindingId: bindingId,
        fileSize: signedBytes.length,
        sha256,
        certificateKey,
        digitallySigned: digitallySigned ? 1 : 0,
        selfSignedCert: selfSignedCert ? 1 : 0,
        tsaTimestamp,
        tsaTokenKey,
        label: 'Signed',
      });
      await db.execute(
        `UPDATE tbl_sign_document
            SET currentVersion = ?, status = 'COMPLETED', completedAt = COALESCE(completedAt, ?)
          WHERE id = ?`,
        [version, new Date(), documentId]
      );

      await auditService.record(null, {
        documentId,
        action: 'DOCUMENT_COMPLETED',
        detail:
          `All recipients signed. Final document sealed (SHA-256 ${sha256.slice(0, 16)}…)` +
          `${digitallySigned ? ', digitally signed' : ''}` +
          `${tsaTimestamp ? `, timestamped ${tsaTimestamp.toISOString()}` : ''}.`,
        metadata: {
          version,
          sha256,
          originalHash: doc!.originalHash,
          digitallySigned,
          selfSignedCert,
          tsaTimestamp,
        },
      });

      // Best-effort completion notice to owner + every recipient with a download link.
      await notifyCompletion(doc!, signedKey).catch((err) => {
        logger.error({ err, documentId }, 'Failed to send completion emails');
      });

      void (async () => {
        try {
          const recipients = await db.selectAll(
            'tbl_sign_recipient',
            'email, name',
            'documentId = ?',
            [documentId]
          );
          await Promise.all(
            (recipients as any[]).map(async (r) => {
              const contactId = await upsertContact({
                email: r.email,
                name: r.name,
                source: 'esign',
              });
              if (contactId) {
                await recordCustomerEvent({
                  type: 'esign_completed',
                  userId: doc!.ownerId,
                  contactId,
                  meta: { documentId },
                });
              }
            })
          );
          await recordCustomerEvent({
            type: 'esign_completed',
            userId: doc!.ownerId,
            meta: { documentId, version, sha256 },
          });
        } catch (err) {
          logger.warn({ err, documentId }, 'Failed to record esign_completed tracking');
        }
      })();

      logger.info({ documentId, version, sha256, digitallySigned, tsaTimestamp }, 'Document finalized');
      return { version, sha256 };
    } catch (err) {
      await db
        .execute("UPDATE tbl_sign_document SET status = 'SENT', completedAt = NULL WHERE id = ?", [
          documentId,
        ])
        .catch(() => undefined);
      logger.error({ err, documentId }, 'Finalization failed; document returned to SENT');
      throw err;
    }
  },

  /**
   * Marks the document FINALIZING and returns true if this caller won the claim.
   * Used by the public complete path before enqueueing the worker job.
   */
  async claimForQueue(documentId: string): Promise<boolean> {
    const claim = await db.execute(
      "UPDATE tbl_sign_document SET status = 'FINALIZING', completedAt = ? WHERE id = ? AND status = 'SENT'",
      [new Date(), documentId]
    );
    return claim.affectedRows > 0;
  },

  async allSignersComplete(documentId: string): Promise<boolean> {
    const row = await db.query(
      `SELECT COUNT(1) AS pending
         FROM tbl_sign_recipient
        WHERE documentId = ?
          AND role IN ('SIGNER', 'APPROVER')
          AND status <> 'COMPLETED'`,
      [documentId]
    );
    return row!.pending === 0;
  },
};

async function notifyCompletion(doc: any, signedKey: string): Promise<void> {
  if (!isMailerConfigured()) {
    logger.warn({ documentId: doc.id }, 'Skipping completion emails — mailer not configured');
    return;
  }

  const owner = await db.select('tbl_user', 'name, email', 'id = ?', [doc.ownerId]);
  const recipients = await db.selectAll('tbl_sign_recipient', 'name, email', 'documentId = ?', [
    doc.id,
  ]);

  const downloadName = `${String(doc.title).replace(/[^a-zA-Z0-9 _-]/g, '')} (signed).pdf`;
  const downloadUrl = await getSignedDownloadUrl(
    signedKey,
    downloadName,
    SIGNING_LIMITS.completionDownloadTtlSeconds
  );

  const parties = new Map<string, string>();
  if (owner?.email) {
    parties.set(String(owner.email).toLowerCase(), owner.name || owner.email);
  }
  for (const r of recipients) {
    if (!r?.email) continue;
    const email = String(r.email).toLowerCase();
    if (!parties.has(email)) parties.set(email, r.name || r.email);
  }

  await Promise.all(
    [...parties.entries()].map(async ([email, name]) => {
      try {
        const mail = completionEmail({ name, documentTitle: doc.title, downloadUrl });
        await sendMail({ ...mail, to: email });
        logger.info({ documentId: doc.id, email }, 'Completion email sent');
      } catch (err) {
        logger.error({ err, documentId: doc.id, email }, 'Completion email failed');
      }
    })
  );
}
