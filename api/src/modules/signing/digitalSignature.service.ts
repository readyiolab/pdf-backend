import { PDFDocument } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { getSigningCert } from '../../lib/signingCert';
import { logger } from '../../lib/logger';
import { requestTimestamp, type TimestampResult } from './trustedTimestamp';

const signpdf = new SignPdf();

export interface SignedPdfResult {
  bytes: Buffer;
  selfSigned: boolean;
  /** The independent TSA timestamp, when one was obtained. */
  timestamp: TimestampResult | null;
}

/**
 * Applies a PAdES/PKCS#7 digital signature to a finished PDF.
 *
 * This is the difference between a self-asserted date in our database and a
 * document a court would accept: the signature covers the entire byte range, so
 * altering a single byte afterwards makes every PDF reader report the signature
 * as invalid. The trust comes from cryptography any reader can check
 * independently, not from our word.
 *
 * Must be the LAST thing done to the file. The signature seals whatever bytes
 * exist at signing time — stamping a field or appending a page afterwards would
 * invalidate it. So the caller assembles everything (stamped content +
 * certificate page) first, then signs.
 *
 * `signingTime` is the authoritative completion time from our records, embedded
 * in the signature. The optional TSA timestamp adds an INDEPENDENT attestation
 * of that time on top.
 */
export async function signPdf(
  assembledBytes: Buffer,
  meta: { signerName: string; reason: string; location?: string; contactInfo?: string; signingTime: Date }
): Promise<SignedPdfResult> {
  const cert = getSigningCert();

  const pdfDoc = await PDFDocument.load(assembledBytes);

  pdflibAddPlaceholder({
    pdfDoc,
    reason: meta.reason,
    contactInfo: meta.contactInfo ?? '',
    name: meta.signerName,
    location: meta.location ?? '',
    signingTime: meta.signingTime,
  });

  // useObjectStreams:false is REQUIRED: @signpdf locates the signature by a
  // literal ByteRange marker in the raw bytes, and object streams compress that
  // marker out of reach. Saving with streams produces a PDF that signs cleanly
  // but whose signature no reader can find.
  const withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  const signer = new P12Signer(cert.p12, { passphrase: cert.passphrase });
  const bytes = await signpdf.sign(withPlaceholder, signer, meta.signingTime);

  // Independent timestamp over the FINAL signed bytes — so it attests to the
  // document exactly as sealed, signature included. Best-effort; null on any
  // TSA failure, which must not fail a completed document.
  const timestamp = await requestTimestamp(bytes);

  logger.info(
    { selfSigned: cert.selfSigned, timestamped: Boolean(timestamp) },
    'Applied digital signature to final document'
  );

  return { bytes, selfSigned: cert.selfSigned, timestamp };
}
