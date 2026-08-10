/**
 * Minimal TipTap JSON → HTML converter for letter PDFs.
 * Supports paragraph, heading, text with bold/italic/underline, bullet/ordered lists, hardBreak.
 */
export function tipTapToHtml(doc: any): string {
  if (!doc) return '';
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return escapeHtml(doc);
    }
  }
  return renderNode(doc);
}

function renderNode(node: any): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(renderNode).join('');

  const type = node.type as string;
  const children = (node.content || []).map(renderNode).join('');

  switch (type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p>${children || '&nbsp;'}</p>`;
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level || 2), 1), 4);
      return `<h${level}>${children}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    case 'hardBreak':
      return '<br/>';
    case 'text':
      return applyMarks(escapeHtml(node.text || ''), node.marks || []);
    default:
      return children;
  }
}

function applyMarks(text: string, marks: any[]): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = `<strong>${out}</strong>`;
        break;
      case 'italic':
        out = `<em>${out}</em>`;
        break;
      case 'underline':
        out = `<u>${out}</u>`;
        break;
      default:
        break;
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Replace {{Token}} placeholders with employee field values. */
export function fillTokens(html: string, data: Record<string, string>): string {
  return html.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const val = data[key];
    return val != null ? escapeHtml(String(val)) : '';
  });
}

export function buildLetterHtml(opts: {
  contentJson: unknown;
  employeeData: Record<string, string>;
  brand?: {
    footerText?: string | null;
    signatoryName?: string | null;
    signatoryDesignation?: string | null;
    defaultFont?: string | null;
    logoUrl?: string | null;
    letterheadUrl?: string | null;
  };
}): string {
  const body = fillTokens(tipTapToHtml(opts.contentJson), opts.employeeData);
  const font = opts.brand?.defaultFont || 'Inter, Arial, sans-serif';
  const logo = opts.brand?.logoUrl
    ? `<img src="${opts.brand.logoUrl}" alt="Logo" style="max-height:64px;margin-bottom:16px"/>`
    : '';
  const letterhead = opts.brand?.letterheadUrl
    ? `<img src="${opts.brand.letterheadUrl}" alt="Letterhead" style="width:100%;max-height:120px;object-fit:contain;margin-bottom:24px"/>`
    : '';
  const signatory = opts.brand?.signatoryName
    ? `<div style="margin-top:48px">
         <div>${escapeHtml(opts.brand.signatoryName)}</div>
         ${opts.brand.signatoryDesignation ? `<div style="color:#555">${escapeHtml(opts.brand.signatoryDesignation)}</div>` : ''}
       </div>`
    : '';
  const footer = opts.brand?.footerText
    ? `<div style="margin-top:48px;font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:12px">${escapeHtml(opts.brand.footerText)}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  body { font-family: ${font}; font-size: 12pt; line-height: 1.65; color: #111; margin: 48px 56px; }
  h1,h2,h3,h4 { margin: 0 0 18px; font-weight: 700; letter-spacing: -0.01em; }
  h2 { font-size: 16pt; text-align: center; }
  p { margin: 0 0 12px; }
  ul,ol { margin: 0 0 14px 22px; }
  li { margin: 0 0 6px; }
</style></head>
<body>
  ${letterhead || logo}
  ${body}
  ${signatory}
  ${footer}
</body></html>`;
}

export function safePdfFileName(
  employeeId: string,
  employeeName: string,
  templateType: string
): string {
  const sanitize = (s: string) =>
    String(s || 'unknown')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80);
  // Never include salary fields in filename
  return `${sanitize(employeeId)}_${sanitize(employeeName)}_${sanitize(templateType)}.pdf`;
}
