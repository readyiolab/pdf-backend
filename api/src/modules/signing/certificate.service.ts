import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { getPool } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 50;
const BRAND = rgb(0.145, 0.388, 0.922); // #2563eb
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.89, 0.91, 0.94);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

/**
 * A cursor that lays out top-down in PDF's bottom-up coordinate space and
 * starts a new page when it runs out of room.
 *
 * Worth the small abstraction: a certificate has an unbounded number of signers
 * and audit rows, so anything that assumes a single page will silently drop
 * evidence off the bottom of the paper on a document with six signers.
 */
class Layout {
  page: PDFPage;
  y: number;
  private pages: PDFPage[] = [];

  constructor(private pdf: PDFDocument, private fonts: Fonts) {
    this.page = pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  /** Ensures `needed` points remain; otherwise breaks to a fresh page. */
  ensure(needed: number): void {
    if (this.y - needed >= MARGIN) return;
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  text(value: string, opts: { size?: number; font?: PDFFont; color?: typeof INK; x?: number; gap?: number } = {}): void {
    const size = opts.size ?? 9;
    const font = opts.font ?? this.fonts.regular;
    this.ensure(size + 4);
    this.y -= size;
    this.page.drawText(value, {
      x: opts.x ?? MARGIN,
      y: this.y,
      size,
      font,
      color: opts.color ?? INK,
    });
    this.y -= opts.gap ?? 4;
  }

  /**
   * Draws a run of prose, wrapped to the page width. pdf-lib's drawText never
   * wraps, so a long sentence handed to text() runs straight off the right
   * margin and is clipped — which is exactly how the explanatory paragraphs used
   * to lose their last few words. Everything narrative goes through here.
   */
  paragraph(
    value: string,
    opts: { size?: number; font?: PDFFont; color?: typeof INK; gap?: number; lineGap?: number } = {}
  ): void {
    const size = opts.size ?? 9;
    const font = opts.font ?? this.fonts.regular;
    const lines = wrap(value, font, size, PAGE_W - MARGIN * 2);
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      this.text(line, { size, font, color: opts.color, gap: last ? opts.gap ?? 6 : opts.lineGap ?? 3 });
    });
  }

  rule(gap = 10): void {
    this.ensure(gap);
    this.y -= gap / 2;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= gap / 2;
  }

  space(points: number): void {
    this.y -= points;
  }

  getPages(): PDFPage[] {
    return this.pages;
  }
}

/** Wraps text to a pixel width. pdf-lib draws raw strings and will not wrap. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // A single word longer than the line (a hash, a long URL) is hard-split
      // rather than allowed to run off the page.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else chunk += char;
        }
        line = chunk;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fmt(value: Date | string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  // UTC throughout. A certificate read in another country must not silently
  // shift a signing timestamp by the reader's local offset.
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export const certificateService = {
  /**
   * Builds the certificate of completion.
   *
   * ── On hashes ──────────────────────────────────────────────────────────────
   * This cites the ORIGINAL document's hash, never the final one. The
   * certificate is appended INTO the signed PDF, so any hash it printed of that
   * PDF would be invalidated the moment it was embedded — a self-referential
   * hash is impossible, and printing one that doesn't verify is worse than
   * printing none. The final hash is computed after assembly and recorded on
   * the version row (and served by /status), where it can actually be checked.
   *
   * What this proves, and the audit trail behind it, is deliberately spelled
   * out on the page: a certificate nobody can interpret is decoration.
   */
  async build(documentId: string): Promise<Buffer> {
    const pool = getPool();

    const [docs]: any = await pool.query('SELECT * FROM tbl_sign_document WHERE id = ?', [documentId]);
    const doc = docs[0];
    if (!doc) throw new AppError('Document not found', 404);

    const [recipients]: any = await pool.query(
      'SELECT * FROM tbl_sign_recipient WHERE documentId = ? ORDER BY signingOrder ASC, createdAt ASC',
      [documentId]
    );
    const [audit]: any = await pool.query(
      `SELECT action, actorName, actorEmail, detail, ipAddress, browser, os, createdAt
         FROM tbl_sign_audit WHERE documentId = ? ORDER BY createdAt ASC`,
      [documentId]
    );
    const [owners]: any = await pool.query('SELECT name, email FROM tbl_user WHERE id = ?', [doc.ownerId]);
    const owner = owners[0] ?? {};

    const pdf = await PDFDocument.create();
    const fonts: Fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      mono: await pdf.embedFont(StandardFonts.Courier),
    };
    const L = new Layout(pdf, fonts);
    const contentWidth = PAGE_W - MARGIN * 2;

    // ── Header ──
    L.text('PDFPRODUCT', { size: 8, font: fonts.bold, color: BRAND, gap: 6 });
    L.text('Certificate of Completion', { size: 20, font: fonts.bold, gap: 8 });
    L.paragraph(
      `This certificate records the electronic signature process for the document below, including who signed, when, and from where.`,
      { size: 9, color: MUTED, gap: 2 }
    );
    L.rule(16);

    // ── Document ──
    L.text('DOCUMENT', { size: 8, font: fonts.bold, color: MUTED, gap: 8 });
    for (const line of wrap(doc.title, fonts.bold, 12, contentWidth)) {
      L.text(line, { size: 12, font: fonts.bold, gap: 3 });
    }
    L.space(4);
    L.text(`File name        ${doc.fileName}`, { size: 9, gap: 3 });
    L.text(`Document ID      ${doc.id}`, { size: 9, font: fonts.mono, gap: 3 });
    L.text(`Pages            ${doc.pageCount || '—'}`, { size: 9, gap: 3 });
    L.text(`Sender           ${owner.name ?? '—'} <${owner.email ?? '—'}>`, { size: 9, gap: 3 });
    L.text(`Signing order    ${doc.flowType === 'SEQUENTIAL' ? 'Sequential (one after another)' : 'Parallel (any order)'}`, { size: 9, gap: 3 });
    L.text(`Created          ${fmt(doc.createdAt)}`, { size: 9, gap: 3 });
    L.text(`Sent             ${fmt(doc.sentAt)}`, { size: 9, gap: 3 });
    L.text(`Completed        ${fmt(doc.completedAt)}`, { size: 9, gap: 3 });
    L.rule(14);

    // ── Integrity ──
    L.text('DOCUMENT INTEGRITY', { size: 8, font: fonts.bold, color: MUTED, gap: 8 });
    L.paragraph(
      'The SHA-256 fingerprint below was computed from the original document when it was uploaded, before any signature was applied. It proves the document presented to the signers is the one recorded here.',
      { size: 8, color: MUTED, gap: 2 }
    );
    L.space(6);
    L.text('Original document SHA-256', { size: 8, font: fonts.bold, gap: 4 });
    for (const line of wrap(doc.originalHash ?? 'not recorded', fonts.mono, 8, contentWidth)) {
      L.text(line, { size: 8, font: fonts.mono, color: BRAND, gap: 2 });
    }
    L.space(6);
    L.paragraph(
      'The completed document carries its own SHA-256, recorded against version ' +
        `${doc.currentVersion} at the time of sealing and available from the document's status record. It is not printed here because this certificate forms part of that file — a fingerprint cannot include itself.`,
      { size: 8, color: MUTED, gap: 8 }
    );
    L.text('Digital signature', { size: 8, font: fonts.bold, gap: 4 });
    L.paragraph(
      'After this certificate was attached, the whole document was sealed with a PKCS#7 digital signature. Any change to a single byte afterwards will cause a PDF reader to report the signature as invalid. The signing time was additionally submitted to an independent RFC 3161 timestamp authority, whose token is retained as third-party proof of when the document existed.',
      { size: 8, color: MUTED, gap: 2 }
    );
    L.rule(14);

    // ── Signers ──
    L.text('SIGNERS', { size: 8, font: fonts.bold, color: MUTED, gap: 8 });

    for (const r of recipients) {
      // Keep a signer's block together rather than splitting their name from
      // their evidence across a page break.
      L.ensure(78);
      L.text(`${r.name}  <${r.email}>`, { size: 10, font: fonts.bold, gap: 3 });
      L.text(
        `Role ${r.role}${r.signingOrder ? `  ·  Order ${r.signingOrder}` : ''}  ·  Status ${r.status}`,
        { size: 8, color: MUTED, gap: 4 }
      );
      L.text(`Viewed        ${fmt(r.viewedAt)}`, { size: 8, gap: 2 });
      L.text(`Signed        ${fmt(r.completedAt)}`, { size: 8, gap: 2 });
      L.text(`IP address    ${r.ipAddress ?? '—'}`, { size: 8, gap: 2 });
      L.text(`Device        ${r.deviceInfo ?? '—'}`, { size: 8, gap: 2 });
      L.text(
        `Verification  ${
          r.authMethod === 'NONE'
            ? 'Email link only'
            : r.otpVerifiedAt
              ? `${r.authMethod === 'EMAIL_OTP' ? 'Email' : 'SMS'} one-time code, passed ${fmt(r.otpVerifiedAt)}`
              : `${r.authMethod} (not completed)`
        }`,
        { size: 8, gap: 2 }
      );
      if (r.declineReason) {
        for (const line of wrap(`Declined: ${r.declineReason}`, fonts.regular, 8, contentWidth)) {
          L.text(line, { size: 8, color: rgb(0.86, 0.15, 0.15), gap: 2 });
        }
      }
      L.space(8);
    }

    L.rule(14);

    // ── Audit trail ──
    L.text('AUDIT TRAIL', { size: 8, font: fonts.bold, color: MUTED, gap: 4 });
    L.text(`${audit.length} event(s), in order.`, { size: 8, color: MUTED, gap: 8 });

    for (const entry of audit) {
      L.ensure(22);
      L.text(fmt(entry.createdAt), { size: 7, font: fonts.mono, color: MUTED, gap: 2 });
      const who = entry.actorName ? `${entry.actorName}` : 'System';
      const where = [entry.ipAddress, entry.browser, entry.os].filter(Boolean).join(' · ');
      const line = `${entry.action.replace(/_/g, ' ')} — ${who}${entry.detail ? `: ${entry.detail}` : ''}`;
      for (const l of wrap(line, fonts.regular, 8, contentWidth)) {
        L.text(l, { size: 8, gap: 2 });
      }
      if (where) L.text(where, { size: 7, color: MUTED, gap: 6 });
      else L.space(4);
    }

    // ── Footer on every page ──
    const pages = L.getPages();
    pages.forEach((page, i) => {
      page.drawLine({
        start: { x: MARGIN, y: MARGIN - 12 },
        end: { x: PAGE_W - MARGIN, y: MARGIN - 12 },
        thickness: 0.75,
        color: RULE,
      });
      page.drawText(`Certificate of Completion · Document ${doc.id}`, {
        x: MARGIN,
        y: MARGIN - 24,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
      const label = `Page ${i + 1} of ${pages.length}`;
      page.drawText(label, {
        x: PAGE_W - MARGIN - fonts.regular.widthOfTextAtSize(label, 7),
        y: MARGIN - 24,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
    });

    return Buffer.from(await pdf.save());
  },

  /**
   * Appends the certificate's pages onto the signed document.
   *
   * Done by copying pages between documents rather than concatenating bytes —
   * PDFs are object graphs with a cross-reference table, so gluing two files
   * together produces a corrupt document that most readers will refuse.
   */
  async appendTo(signedBytes: Buffer, certificateBytes: Buffer): Promise<Buffer> {
    const signed = await PDFDocument.load(signedBytes);
    const certificate = await PDFDocument.load(certificateBytes);

    const copied = await signed.copyPages(certificate, certificate.getPageIndices());
    for (const page of copied) signed.addPage(page);

    return Buffer.from(await signed.save());
  },
};
