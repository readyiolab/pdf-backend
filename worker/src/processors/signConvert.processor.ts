import crypto from 'crypto';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { db } from '../lib/mysql';
import { logger } from '../lib/logger';
import { convertOfficeFileToPdf } from '../lib/officeToPdf';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { jobStorageContext } from '../storage/context';

export interface SignConvertPayload {
  documentId: string;
  sourceFileKey: string;
  storageBindingId: string | null;
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function markConversionFailed(documentId: string, detail: string): Promise<void> {
  await db.execute(
    `UPDATE tbl_sign_document SET status = 'CONVERSION_FAILED', updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [documentId]
  );
  try {
    await db.insert('tbl_sign_audit', {
      id: crypto.randomUUID(),
      documentId,
      action: 'CONVERSION_FAILED',
      detail,
    });
  } catch (err) {
    logger.error({ err, documentId }, 'Failed to write CONVERSION_FAILED audit');
  }
}

export async function signConvertProcessor(payload: SignConvertPayload): Promise<void> {
  const { documentId, sourceFileKey, storageBindingId } = payload;

  const rows = await db.queryAll('SELECT * FROM tbl_sign_document WHERE id = ? LIMIT 1', [documentId]);
  const doc = rows[0] as any;
  if (!doc) {
    logger.warn({ documentId }, 'sign-convert: document not found');
    return;
  }
  if (doc.status !== 'CONVERTING') {
    logger.info({ documentId, status: doc.status }, 'sign-convert: skipping non-CONVERTING document');
    return;
  }

  const organizationId = doc.fileKey?.match(/^org-([^/]+)\//)?.[1] ?? null;

  return jobStorageContext.run({ organizationId, storageBindingId }, async () => {
    let localInputPath = '';
    let convertedLocalPath = '';

    try {
      localInputPath = await downloadFromS3(sourceFileKey);
      convertedLocalPath = await convertOfficeFileToPdf(localInputPath);

      const pdfKey = doc.fileKey as string;
      const uploadedKey = await uploadToS3(convertedLocalPath, pdfKey, 'application/pdf');
      const fileSize = fs.statSync(convertedLocalPath).size;
      const originalHash = sha256File(convertedLocalPath);

      const pdfBytes = fs.readFileSync(convertedLocalPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pageCount = pdfDoc.getPageCount();

      await db.execute(
        `UPDATE tbl_sign_document
            SET status = 'DRAFT', fileKey = ?, fileSize = ?, pageCount = ?, originalHash = ?,
                updatedAt = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND status = 'CONVERTING'`,
        [uploadedKey, fileSize, pageCount, originalHash, documentId]
      );

      await db.execute(
        `UPDATE tbl_sign_document_version
            SET fileKey = ?, fileSize = ?, sha256 = ?, label = 'Original'
          WHERE documentId = ? AND version = 1`,
        [uploadedKey, fileSize, originalHash, documentId]
      );

      await db.insert('tbl_sign_audit', {
        id: crypto.randomUUID(),
        documentId,
        action: 'DOCUMENT_CONVERTED',
        detail: `Converted Word document to PDF (${pageCount} page${pageCount === 1 ? '' : 's'})`,
      });

      logger.info({ documentId, pageCount, fileSize }, 'sign-convert: completed');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Word conversion failed';
      logger.error({ err, documentId }, 'sign-convert: failed');
      await markConversionFailed(documentId, detail);
      throw err;
    } finally {
      cleanupLocalFile(localInputPath);
      if (convertedLocalPath) cleanupLocalFile(convertedLocalPath);
    }
  });
}
