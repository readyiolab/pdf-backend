// Magic-byte (file signature) detection. The client-supplied Content-Type is not
// trustworthy, so real input validation must inspect the actual bytes.

export type FileCategory = 'pdf' | 'image' | 'office' | 'unknown';

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Detects a coarse file category from the leading bytes of a file.
 * Only needs the first ~1KB, so it works on a ranged read.
 */
export function detectFileCategory(buf: Buffer): FileCategory {
  // PDF: "%PDF-" — allow a small amount of leading junk some generators emit.
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';

  // Images
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image'; // PNG
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image'; // WEBP
  if (startsWith(buf, [0x42, 0x4d])) return 'image'; // BMP

  // Office: modern formats are ZIP containers; legacy are OLE compound files.
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'office'; // ZIP (docx/xlsx/pptx)
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'office'; // OLE (doc/xls/ppt)

  return 'unknown';
}
