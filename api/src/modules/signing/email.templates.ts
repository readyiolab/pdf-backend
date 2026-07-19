import type { MailMessage } from '../../lib/mailer';

/**
 * Transactional email bodies.
 *
 * Table-based layout with inline styles on purpose — this is not the place for
 * modern CSS. Outlook renders with Word's HTML engine (no flex, no grid, no
 * float), and Gmail strips <style> blocks in several clients. A layout that
 * looks right in a browser routinely collapses in a real inbox, so the visual
 * polish here comes from spacing, type and colour on tables — the same toolkit
 * transactional senders like Stripe and DigitalOcean use.
 *
 * Every message ships a plain-text alternative: a missing text/plain part is a
 * significant spam-score penalty, and these are already going out over a
 * personal Gmail account.
 */

const BRAND = '#2563eb';
const INK = '#0f172a';
const BODY = '#334155';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const LINE = '#e2e8f0';
const CANVAS = '#f1f5f9';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string): string {
  // Recipient names and document titles are user-supplied and land inside HTML
  // we email out. Without escaping, a title of `<img src=x onerror=...>` is
  // injected into whatever the recipient's client will execute.
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shared shell: a light canvas, a single white card with a slim branded
 * top rule, a header, the body, and a quiet footer. `preheader` is the snippet
 * inboxes show next to the subject — hidden in the body but worth setting so the
 * preview isn't a scrape of the first visible words.
 */
function layout(opts: { heading: string; preheader: string; bodyHtml: string }): string {
  const { heading, preheader, bodyHtml } = opts;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};font-family:${FONT};-webkit-font-smoothing:antialiased;">
    <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(
      preheader
    )}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">
            <!-- brand -->
            <tr>
              <td style="padding:0 4px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:28px;height:28px;border-radius:7px;background:${BRAND};text-align:center;vertical-align:middle;font-size:15px;font-weight:700;color:#ffffff;font-family:${FONT};">P</td>
                    <td style="padding-left:9px;font-size:15px;font-weight:600;color:${INK};font-family:${FONT};">PDFProduct</td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- card -->
            <tr>
              <td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
                <div style="height:4px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:28px 34px 30px;">
                      <h1 style="margin:0 0 4px;font-size:20px;line-height:1.35;color:${INK};font-weight:650;">${heading}</h1>
                      ${bodyHtml}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- footer -->
            <tr>
              <td style="padding:22px 8px 0;">
                <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${MUTED};font-family:${FONT};">
                  Sent by <strong style="color:${BODY};">PDFProduct</strong> · secure document signing
                </p>
                <p style="margin:0;font-size:11px;line-height:1.6;color:${FAINT};font-family:${FONT};">
                  You received this because someone used PDFProduct to send you a document. If it wasn't expected, you can safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function paragraph(html: string, marginTop = 14): string {
  return `<p style="margin:${marginTop}px 0 0;font-size:15px;line-height:1.65;color:${BODY};">${html}</p>`;
}

function button(url: string, label: string): string {
  // Bulletproof-ish button: the rounded background lives on the <a> so Outlook
  // (which ignores padding on table cells inconsistently) still shows a filled
  // pill rather than a bare link.
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 6px;">
    <tr>
      <td style="border-radius:9px;background:${BRAND};box-shadow:0 1px 2px rgba(37,99,235,.25);">
        <a href="${url}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;font-family:${FONT};">${label} &rarr;</a>
      </td>
    </tr>
  </table>`;
}

/** A quiet inset panel for supporting detail (a personal note, a fallback link). */
function panel(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;">
    <tr>
      <td style="background:${CANVAS};border:1px solid ${LINE};border-radius:10px;padding:14px 16px;">${html}</td>
    </tr>
  </table>`;
}

export function invitationEmail(params: {
  signerName: string;
  senderName: string;
  documentTitle: string;
  signUrl: string;
  message?: string | null;
  expiresAt: Date | null;
}): MailMessage {
  const { signerName, senderName, documentTitle, signUrl, message, expiresAt } = params;
  const expiryLine = expiresAt
    ? `This link expires on <strong>${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>. `
    : '';

  const html = layout({
    heading: `${escapeHtml(senderName)} requested your signature`,
    preheader: `${senderName} sent you "${documentTitle}" to review and sign.`,
    bodyHtml: `
      ${paragraph(`Hi ${escapeHtml(signerName)},`)}
      ${paragraph(
        `<strong style="color:${INK};">${escapeHtml(senderName)}</strong> has sent you <strong style="color:${INK};">${escapeHtml(
          documentTitle
        )}</strong> to review and sign. It only takes a minute — no account required.`
      )}
      ${
        message
          ? panel(
              `<p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${FAINT};">Message from ${escapeHtml(
                senderName
              )}</p><p style="margin:0;font-size:14px;line-height:1.6;color:${BODY};">${escapeHtml(message)}</p>`
            )
          : ''
      }
      ${button(signUrl, 'Review & sign')}
      <p style="margin:14px 0 0;font-size:13px;line-height:1.65;color:${MUTED};">
        ${expiryLine}Opening the link takes you straight to the document.
      </p>
      ${panel(
        `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${MUTED};">Button not working? Paste this link into your browser:</p>
         <p style="margin:0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${signUrl}" style="color:${BRAND};text-decoration:none;">${signUrl}</a></p>`
      )}
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${FAINT};">
        🔒 This link is personal to you. Please don't forward it — anyone who has it can open the document.
      </p>
    `,
  });

  const text = [
    `Hi ${signerName},`,
    '',
    `${senderName} has sent you "${documentTitle}" to review and sign. No account is required.`,
    message ? `\nMessage from ${senderName}:\n${message}\n` : '',
    `Review & sign:`,
    signUrl,
    '',
    expiresAt
      ? `This link expires on ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
      : '',
    "This link is personal to you. Please don't forward it — anyone who has it can open the document.",
  ]
    .filter(Boolean)
    .join('\n');

  return { to: '', subject: `${senderName} requested your signature on ${documentTitle}`, html, text };
}

export function otpEmail(params: {
  name: string;
  code: string;
  documentTitle: string;
  ttlMinutes: number;
}): Omit<MailMessage, 'to'> {
  const { name, code, documentTitle, ttlMinutes } = params;

  const html = layout({
    heading: 'Your verification code',
    preheader: `${code} — your code to sign "${documentTitle}". Expires in ${ttlMinutes} minutes.`,
    bodyHtml: `
      ${paragraph(`Hi ${escapeHtml(name)},`)}
      ${paragraph(
        `Enter this code to verify your identity before signing <strong style="color:${INK};">${escapeHtml(
          documentTitle
        )}</strong>:`
      )}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;">
        <tr>
          <td style="background:${CANVAS};border:1px solid ${LINE};border-radius:12px;padding:16px 26px;font-size:34px;font-weight:700;letter-spacing:.3em;color:${INK};font-family:'SF Mono',Menlo,Consolas,monospace;">
            ${escapeHtml(code)}
          </td>
        </tr>
      </table>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.65;color:${MUTED};">
        It expires in <strong>${ttlMinutes} minutes</strong>. If you didn't request this, someone may have your signing link — do not share this code with anyone.
      </p>
    `,
  });

  const text = [
    `Hi ${name},`,
    '',
    `Your verification code for "${documentTitle}" is: ${code}`,
    '',
    `It expires in ${ttlMinutes} minutes.`,
    "If you didn't request this, do not share this code with anyone.",
  ].join('\n');

  return { subject: `${code} is your verification code`, html, text };
}

export function completionEmail(params: {
  name: string;
  documentTitle: string;
  downloadUrl: string;
}): Omit<MailMessage, 'to'> {
  const { name, documentTitle, downloadUrl } = params;

  const html = layout({
    heading: 'Everyone has signed ✓',
    preheader: `"${documentTitle}" is fully signed — download the completed document and certificate.`,
    bodyHtml: `
      ${paragraph(`Hi ${escapeHtml(name)},`)}
      ${paragraph(
        `<strong style="color:${INK};">${escapeHtml(
          documentTitle
        )}</strong> has been signed by everyone. The completed document and its audit certificate are ready to download.`
      )}
      ${button(downloadUrl, 'Download signed document')}
      <p style="margin:14px 0 0;font-size:13px;line-height:1.65;color:${MUTED};">
        The download includes a Certificate of Completion recording who signed, when, and from where.
      </p>
    `,
  });

  const text = [
    `Hi ${name},`,
    '',
    `"${documentTitle}" has been signed by everyone.`,
    '',
    `Download the completed document and certificate:`,
    downloadUrl,
  ].join('\n');

  return { subject: `Completed: ${documentTitle}`, html, text };
}
