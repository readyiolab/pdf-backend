import type { MailMessage } from '../../lib/mailer';

/**
 * Transactional email bodies.
 *
 * Table-based layout with inline styles on purpose — this is not the place for
 * modern CSS. Outlook renders with Word's HTML engine (no flex, no grid, no
 * float), and Gmail strips <style> blocks in several clients. A layout that
 * looks right in a browser routinely collapses in a real inbox.
 *
 * Every message ships a plain-text alternative: a missing text/plain part is a
 * significant spam-score penalty, and these are already going out over a
 * personal Gmail account.
 */

const BRAND = '#2563eb';

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

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:${BRAND};letter-spacing:.02em;">PDFProduct</p>
                <h1 style="margin:0;font-size:20px;line-height:1.3;color:#0f172a;font-weight:600;">${heading}</h1>
              </td>
            </tr>
            <tr><td style="padding:8px 32px 28px;">${bodyHtml}</td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;">
            Sent by PDFProduct. If you weren't expecting this, you can ignore it.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr>
      <td style="border-radius:8px;background:${BRAND};">
        <a href="${url}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
      </td>
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
    ? `This link expires on ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
    : '';

  const html = layout(
    `${escapeHtml(senderName)} has requested your signature`,
    `
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">Hi ${escapeHtml(signerName)},</p>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">
        <strong>${escapeHtml(senderName)}</strong> has sent you
        <strong>${escapeHtml(documentTitle)}</strong> to sign.
      </p>
      ${
        message
          ? `<table role="presentation" width="100%" style="margin:16px 0 0;"><tr>
               <td style="border-left:3px solid #e2e8f0;padding:4px 0 4px 12px;font-size:13px;line-height:1.6;color:#64748b;font-style:italic;">
                 ${escapeHtml(message)}
               </td></tr></table>`
          : ''
      }
      ${button(signUrl, 'Review & sign')}
      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
        ${expiryLine} You don't need an account — the link opens the document directly.
      </p>
      <p style="margin:16px 0 0;font-size:11px;line-height:1.5;color:#94a3b8;word-break:break-all;">
        If the button doesn't work, paste this into your browser:<br />${signUrl}
      </p>
      <p style="margin:16px 0 0;font-size:11px;line-height:1.5;color:#94a3b8;">
        This link is personal to you. Please don't forward it — anyone with it can open the document.
      </p>
    `
  );

  const text = [
    `Hi ${signerName},`,
    '',
    `${senderName} has sent you "${documentTitle}" to sign.`,
    message ? `\nMessage from ${senderName}: ${message}\n` : '',
    `Review & sign: ${signUrl}`,
    '',
    expiryLine,
    "You don't need an account.",
    '',
    "This link is personal to you. Please don't forward it — anyone with it can open the document.",
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

  const html = layout(
    'Your verification code',
    `
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">Hi ${escapeHtml(name)},</p>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">
        Use this code to verify your identity before signing
        <strong>${escapeHtml(documentTitle)}</strong>:
      </p>
      <p style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:.28em;color:#0f172a;font-family:'SF Mono',Menlo,Consolas,monospace;">
        ${escapeHtml(code)}
      </p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
        It expires in ${ttlMinutes} minutes. If you didn't request this, someone may have your signing
        link — do not share this code with anyone.
      </p>
    `
  );

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

  const html = layout(
    'Everyone has signed',
    `
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">Hi ${escapeHtml(name)},</p>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#334155;">
        <strong>${escapeHtml(documentTitle)}</strong> has been signed by all parties. The completed
        document and its audit certificate are ready.
      </p>
      ${button(downloadUrl, 'Download signed document')}
    `
  );

  const text = [
    `Hi ${name},`,
    '',
    `"${documentTitle}" has been signed by all parties.`,
    '',
    `Download: ${downloadUrl}`,
  ].join('\n');

  return { subject: `Completed: ${documentTitle}`, html, text };
}
