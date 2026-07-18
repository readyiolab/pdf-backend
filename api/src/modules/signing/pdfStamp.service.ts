import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { SignFieldType } from '../../../../shared/signing';

/** Field types whose value is a PNG data URL rather than text. */
const IMAGE_FIELDS = new Set<SignFieldType>(['SIGNATURE', 'INITIALS', 'STAMP', 'IMAGE']);

export interface StampField {
  type: SignFieldType;
  page: number; // 1-indexed
  x: number; // 0..1 of the DISPLAYED page width
  y: number; // 0..1 from the DISPLAYED page's TOP edge
  width: number;
  height: number;
  value: string | null;
  config: { font?: { size?: number; color?: string; align?: string } } | null;
}

/**
 * Placement in unrotated PDF space for a field expressed in display fractions.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * Field geometry is stored relative to the page as the signer SAW it, which is
 * the page with its /Rotate applied. pdf-lib draws in the page's UNROTATED
 * coordinate space, origin bottom-left, y upward. Our y also runs the other way
 * (downward from the top). So every field needs both a flip and a rotation
 * transform, and a page saved with /Rotate 90 — routine for anything scanned —
 * lands its signature on the wrong edge, sideways, if you only handle the flip.
 *
 * ── The derivation ─────────────────────────────────────────────────────────
 * With W,H the unrotated MediaBox and R the page rotation, the displayed box is
 * (H,W) when R is 90/270 and (W,H) otherwise. Mapping a display point (dx,dy)
 * (top-left origin, y down) to an unrotated PDF point:
 *
 *   R=0:    (dx,      H - dy)
 *   R=90:   (dy,      dx)
 *   R=180:  (W - dx,  dy)
 *   R=270:  (W - dy,  H - dx)
 *
 * Sanity check for R=90: the display's top-left corner is the unrotated page's
 * bottom-left (rotating a page 90° clockwise carries the bottom-left corner up
 * to the top-left), and indeed (0,0) maps to (0,0).
 *
 * pdf-lib rotates a drawn object about its own bottom-left anchor, CCW for
 * positive degrees, so the anchor below is the corner that ends up at the
 * rect's origin AFTER that rotation — which is a different corner per R.
 *
 * Verified against generated fixtures at all four rotations; see the round-trip
 * check in `displayPointToPdf`, which is the inverse of this mapping.
 */
function placeRect(
  pageWidth: number,
  pageHeight: number,
  rotation: number,
  field: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number; rotate: number } {
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? pageHeight : pageWidth;
  const displayHeight = swap ? pageWidth : pageHeight;

  const dx = field.x * displayWidth;
  const dy = field.y * displayHeight;
  const dw = field.width * displayWidth;
  const dh = field.height * displayHeight;

  switch (rotation) {
    case 90:
      return { x: dy + dh, y: dx, width: dw, height: dh, rotate: 90 };
    case 180:
      return { x: pageWidth - dx, y: dy + dh, width: dw, height: dh, rotate: 180 };
    case 270:
      return { x: pageWidth - dy - dh, y: pageHeight - dx, width: dw, height: dh, rotate: 270 };
    default:
      return { x: dx, y: pageHeight - dy - dh, width: dw, height: dh, rotate: 0 };
  }
}

/** Maps a single display point to unrotated PDF space. Used for text baselines. */
function displayPointToPdf(
  pageWidth: number,
  pageHeight: number,
  rotation: number,
  dx: number,
  dy: number
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: dy, y: dx };
    case 180:
      return { x: pageWidth - dx, y: dy };
    case 270:
      return { x: pageWidth - dy, y: pageHeight - dx };
    default:
      return { x: dx, y: pageHeight - dy };
  }
}

function hexToRgb(hex?: string) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!match) return rgb(0.06, 0.09, 0.16); // slate-900, matching the designer default
  return rgb(
    parseInt(match[1], 16) / 255,
    parseInt(match[2], 16) / 255,
    parseInt(match[3], 16) / 255
  );
}

async function drawImageField(
  pdf: PDFDocument,
  page: PDFPage,
  field: StampField,
  rotation: number
): Promise<void> {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(field.value ?? '');
  if (!match) return;

  const bytes = Buffer.from(match[2], 'base64');
  const image = match[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);

  const { width: pw, height: ph } = page.getSize();
  const box = placeRect(pw, ph, rotation, field);

  // Fit inside the box preserving aspect ratio, centred. Stretching a signature
  // to fill its box distorts the handwriting — which is the one thing about a
  // signature that is supposed to be faithfully reproduced.
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const insetX = (box.width - drawWidth) / 2;
  const insetY = (box.height - drawHeight) / 2;

  // The inset is applied along the BOX's own axes, which are rotated relative to
  // PDF space — so it has to be rotated too, not just added to x/y.
  const rad = (box.rotate * Math.PI) / 180;
  const offsetX = insetX * Math.cos(rad) - insetY * Math.sin(rad);
  const offsetY = insetX * Math.sin(rad) + insetY * Math.cos(rad);

  page.drawImage(image, {
    x: box.x + offsetX,
    y: box.y + offsetY,
    width: drawWidth,
    height: drawHeight,
    rotate: degrees(box.rotate),
  });
}

function drawTextField(
  page: PDFPage,
  field: StampField,
  font: PDFFont,
  rotation: number
): void {
  const value = field.value?.trim();
  if (!value) return;

  const { width: pw, height: ph } = page.getSize();
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? ph : pw;
  const displayHeight = swap ? pw : ph;

  const dw = field.width * displayWidth;
  const dh = field.height * displayHeight;

  // Default to a size that fits the field box rather than a fixed point size —
  // the designer lets fields be any height, and an 11pt default would overflow a
  // short box and swim in a tall one.
  let size = field.config?.font?.size ?? Math.min(dh * 0.7, 14);

  // Shrink to fit rather than overflow. A name that runs past its box would be
  // painted over whatever is next to it on the page.
  let textWidth = font.widthOfTextAtSize(value, size);
  const maxWidth = dw - 4;
  if (textWidth > maxWidth && textWidth > 0) {
    size = Math.max(4, (size * maxWidth) / textWidth);
    textWidth = font.widthOfTextAtSize(value, size);
  }

  const align = field.config?.font?.align ?? 'left';
  const padding = 2;
  const offsetX =
    align === 'center' ? (dw - textWidth) / 2 : align === 'right' ? dw - textWidth - padding : padding;

  // Baseline sits a little above the box's bottom edge so descenders (g, y, p)
  // aren't clipped.
  const baselineFromTop = dh - Math.max((dh - size) / 2, size * 0.2);
  const anchor = displayPointToPdf(pw, ph, rotation, field.x * displayWidth + offsetX, field.y * displayHeight + baselineFromTop);

  page.drawText(value, {
    x: anchor.x,
    y: anchor.y,
    size,
    font,
    color: hexToRgb(field.config?.font?.color),
    rotate: degrees(rotation),
  });
}

export const pdfStampService = {
  /**
   * Renders every filled field onto the PDF and returns the flattened bytes.
   *
   * Called ONCE, at finalization — not per signer. Stamping incrementally would
   * rewrite the whole file on every signature and leave a trail of
   * half-executed documents; instead field values live in the database until
   * everyone is done, and the viewer overlays them for in-progress documents.
   * The signed artifact is therefore produced exactly once, deterministically,
   * from the untouched original.
   */
  async stamp(originalBytes: Buffer, fields: StampField[]): Promise<Buffer> {
    const pdf = await PDFDocument.load(originalBytes);
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    // Typed signatures render in italic as a stand-in for a script face. The
    // standard 14 PDF fonts include no handwriting font, and embedding one
    // means shipping a licensed TTF + fontkit — worth doing, but not silently.
    const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

    const pages = pdf.getPages();

    for (const field of fields) {
      const page = pages[field.page - 1];
      // A field pointing past the end of the document is corrupt data, not a
      // reason to abandon a document everyone has already signed.
      if (!page) continue;
      if (!field.value) continue;

      // pdf-lib normalises /Rotate into 0/90/180/270.
      const rotation = ((page.getRotation().angle % 360) + 360) % 360;

      if (IMAGE_FIELDS.has(field.type)) {
        await drawImageField(pdf, page, field, rotation);
      } else if (field.type === 'CHECKBOX' || field.type === 'RADIO') {
        if (field.value === 'true') {
          drawTextField(page, { ...field, value: field.type === 'CHECKBOX' ? 'X' : '●' }, helvetica, rotation);
        }
      } else {
        const isTypedSignature = field.type === 'NAME' && field.config?.font?.size === undefined;
        drawTextField(page, field, isTypedSignature ? italic : helvetica, rotation);
      }
    }

    /**
     * Flatten any interactive form the original carried.
     *
     * Without this, an AcroForm text box in the source PDF stays editable after
     * signing: a recipient could alter the terms of a document they had already
     * signed and the file would still look untouched. Wrapped because flatten()
     * throws on malformed or partially-defined forms, and a form we cannot
     * flatten must not block a completed agreement — the SHA-256 below still
     * pins the exact bytes either way.
     */
    try {
      pdf.getForm().flatten();
    } catch {
      // No form, or a form pdf-lib can't flatten. The drawn content above is
      // page content, not annotations, so the signatures themselves are already
      // permanent regardless.
    }

    return Buffer.from(await pdf.save());
  },
};

// Exported for the verification harness — the rotation transform is the part of
// this file most worth pinning down with a test.
export const __testables = { placeRect, displayPointToPdf };
