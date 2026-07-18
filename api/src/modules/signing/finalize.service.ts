import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, getObjectBytes, hashObject } from '../../lib/s3';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { pdfStampService, type StampField } from './pdfStamp.service';
import { certificateService } from './certificate.service';
import { signPdf } from './digitalSignature.service';
import { auditService } from './audit.service';

export const finalizeService = {
  /**
   * Produces the signed PDF once every signer is done.
   *
   * ── Runs inline, and shouldn't forever ─────────────────────────────────────
   * Stamping downloads the original, rewrites it, and re-uploads — for a 50MB
   * document that is seconds of CPU inside the last signer's HTTP request. This
   * belongs on the existing `heavy-jobs` BullMQ queue alongside compress/OCR.
   * It is inline only because Redis is unreachable in the current environment;
   * moving it is a queue push, not a redesign, because everything below is
   * driven from the database rather than from request state.
   *
   * Idempotent: guarded by the document's status, so a retry or a double-submit
   * cannot produce two signed versions.
   */
  async finalize(documentId: string): Promise<{ version: number; sha256: string } | null> {
    const pool = getPool();

    // Claim the document atomically. If two signers submit their last field at
    // the same instant, both would otherwise see "everyone is done" and stamp
    // concurrently — two versions, two hashes, one of them orphaned. The guarded
    // UPDATE means exactly one request wins.
    const [claim]: any = await pool.query(
      "UPDATE tbl_sign_document SET status = 'COMPLETED', completedAt = ? WHERE id = ? AND status = 'SENT'",
      [new Date(), documentId]
    );
    if (claim.affectedRows === 0) {
      logger.info({ documentId }, 'Finalization skipped — document was not in SENT state');
      return null;
    }

    try {
      const [docs]: any = await pool.query('SELECT * FROM tbl_sign_document WHERE id = ?', [documentId]);
      const doc = docs[0];

      const [fields]: any = await pool.query(
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

      // Always stamp onto the ORIGINAL (v1), never onto a previous signed
      // version. Every value lives in the database, so the signed artifact is a
      // pure function of (original, values) — reproducible, and immune to a
      // half-stamped intermediate file poisoning the result.
      const originalBytes = await getObjectBytes(doc.fileKey);

      // Verify the original hasn't changed under us since upload. If it has,
      // something is badly wrong (storage tampering, key collision) and signing
      // over it would launder that into a "signed" document.
      const currentHash = crypto.createHash('sha256').update(originalBytes).digest('hex');
      if (doc.originalHash && currentHash !== doc.originalHash) {
        throw new Error(
          `Original document hash mismatch for ${documentId}: stored ${doc.originalHash}, found ${currentHash}`
        );
      }

      const stampedBytes = await pdfStampService.stamp(originalBytes, stampFields);

      const version = (doc.currentVersion ?? 1) + 1;
      const folder = doc.fileKey.replace(/\/original_.*$/, '');
      const signedKey = `${folder}/signed_v${version}.pdf`;
      const certificateKey = `${folder}/certificate_v${version}.pdf`;

      // Built AFTER the recipient rows are final (the last signer's completedAt,
      // IP and device are already committed) so the certificate reflects the
      // finished process rather than a snapshot mid-signature.
      const certificateBytes = await certificateService.build(documentId);
      const assembledBytes = await certificateService.appendTo(stampedBytes, certificateBytes);

      // Digitally sign LAST, over the fully assembled document (content +
      // certificate). The PKCS#7 signature seals these exact bytes, so this must
      // be the final transformation — anything after it invalidates the seal.
      // The signing time is our authoritative completion time; the TSA (if
      // reached) attests to it independently. Best-effort: a signing failure
      // must not strand a document everyone has already signed, so we fall back
      // to the unsigned-but-hashed assembly.
      let signedBytes = assembledBytes;
      let digitallySigned = false;
      let selfSignedCert = false;
      let tsaTimestamp: Date | null = null;
      let tsaTokenKey: string | null = null;
      try {
        const result = await signPdf(assembledBytes, {
          signerName: 'PDFProduct',
          reason: `Signed by all parties of "${doc.title}"`,
          location: 'PDFProduct e-Sign',
          signingTime: new Date(),
        });
        signedBytes = result.bytes;
        digitallySigned = true;
        selfSignedCert = result.selfSigned;

        if (result.timestamp) {
          tsaTimestamp = result.timestamp.timestamp;
          tsaTokenKey = `${folder}/timestamp_v${version}.tsr`;
          await s3.send(
            new PutObjectCommand({
              Bucket: env.DO_SPACES_BUCKET,
              Key: tsaTokenKey,
              Body: result.timestamp.token,
              ContentType: 'application/timestamp-reply',
            })
          );
        }
      } catch (err) {
        logger.error({ err, documentId }, 'Digital signature failed; storing unsigned final document');
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: env.DO_SPACES_BUCKET,
          Key: signedKey,
          Body: signedBytes,
          ContentType: 'application/pdf',
        })
      );
      // Also stored standalone so /certificate can serve it without making the
      // caller download the whole agreement to read the audit summary.
      await s3.send(
        new PutObjectCommand({
          Bucket: env.DO_SPACES_BUCKET,
          Key: certificateKey,
          Body: certificateBytes,
          ContentType: 'application/pdf',
        })
      );

      // Hash the bytes as STORED, not the buffer we uploaded. If storage mangled
      // anything in transit, the certificate must attest to what is actually
      // there — a hash of the local buffer would certify a file that doesn't exist.
      const sha256 = await hashObject(signedKey);

      await pool.query(
        `INSERT INTO tbl_sign_document_version
           (id, documentId, version, fileKey, fileSize, sha256, certificateKey, digitallySigned, selfSignedCert, tsaTimestamp, tsaTokenKey, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Signed')`,
        [crypto.randomUUID(), documentId, version, signedKey, signedBytes.length, sha256, certificateKey, digitallySigned ? 1 : 0, selfSignedCert ? 1 : 0, tsaTimestamp, tsaTokenKey]
      );
      await pool.query('UPDATE tbl_sign_document SET currentVersion = ? WHERE id = ?', [version, documentId]);

      await auditService.record(null, {
        documentId,
        action: 'DOCUMENT_COMPLETED',
        detail:
          `All recipients signed. Final document sealed (SHA-256 ${sha256.slice(0, 16)}…)` +
          `${digitallySigned ? ', digitally signed' : ''}` +
          `${tsaTimestamp ? `, timestamped ${tsaTimestamp.toISOString()}` : ''}.`,
        metadata: { version, sha256, originalHash: doc.originalHash, digitallySigned, selfSignedCert, tsaTimestamp },
      });

      logger.info({ documentId, version, sha256, digitallySigned, tsaTimestamp }, 'Document finalized');
      return { version, sha256 };
    } catch (err) {
      // Roll the claim back so the document isn't stranded as COMPLETED with no
      // signed file — a state where the UI offers a download that doesn't exist.
      await pool
        .query("UPDATE tbl_sign_document SET status = 'SENT', completedAt = NULL WHERE id = ?", [documentId])
        .catch(() => undefined);
      logger.error({ err, documentId }, 'Finalization failed; document returned to SENT');
      throw err;
    }
  },

  /** True when every recipient who was asked to act has finished. */
  async allSignersComplete(documentId: string): Promise<boolean> {
    const [rows]: any = await getPool().query(
      `SELECT COUNT(1) AS pending
         FROM tbl_sign_recipient
        WHERE documentId = ?
          AND role IN ('SIGNER', 'APPROVER')
          AND status <> 'COMPLETED'`,
      [documentId]
    );
    return rows[0].pending === 0;
  },
};
