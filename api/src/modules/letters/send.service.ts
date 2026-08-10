import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { encryptJson, decryptJson, isSecretBoxConfigured } from '../../lib/secretBox';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { writeLetterAudit } from '../orgs/orgs.service';
import { batchService } from './batch.service';
import { enqueueLetterSend } from '../../lib/letterQueues';
import { orgScope } from './orgScope';

function newId() {
  return crypto.randomUUID();
}

export const mailAccountService = {
  async list(userId: string) {
    const rows = await db.selectAll(
      'tbl_user_mail_account',
      'id, provider, emailAddress, status, createdAt, updatedAt',
      'userId = ?',
      [userId],
      'createdAt DESC'
    );
    return rows;
  },

  /** Build OAuth authorize URL for Microsoft or Google. */
  getAuthorizeUrl(provider: 'OUTLOOK' | 'GMAIL', userId: string, stateNonce: string): string {
    const redirectUri = `${env.APP_URL}/letters/mail/callback`;
    const state = Buffer.from(JSON.stringify({ userId, provider, nonce: stateNonce })).toString(
      'base64url'
    );

    if (provider === 'OUTLOOK') {
      const clientId = env.MICROSOFT_CLIENT_ID || '';
      if (!clientId) {
        throw new AppError('MICROSOFT_CLIENT_ID is not configured', 503);
      }
      const scopes = encodeURIComponent('openid offline_access Mail.Send Mail.ReadWrite User.Read');
      return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${scopes}&state=${state}`;
    }

    const clientId = env.GOOGLE_CLIENT_ID || '';
    if (!clientId) throw new AppError('GOOGLE_CLIENT_ID is not configured', 503);
    const scopes = encodeURIComponent('https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&access_type=offline&prompt=consent&state=${state}`;
  },

  async upsertFromOAuth(
    userId: string,
    provider: 'OUTLOOK' | 'GMAIL',
    tokens: Record<string, unknown>,
    emailAddress: string
  ) {
    if (!isSecretBoxConfigured()) {
      throw new AppError('Server cannot store mail tokens without INFRA_CREDENTIALS_KEY', 503);
    }
    const existing = await db.select(
      'tbl_user_mail_account',
      '*',
      'userId = ? AND provider = ?',
      [userId, provider]
    );
    const encryptedTokens = encryptJson(tokens);
    if (existing) {
      await db.update(
        'tbl_user_mail_account',
        { encryptedTokens, emailAddress, status: 'CONNECTED' },
        'id = ?',
        [existing.id]
      );
      return { id: existing.id, provider, emailAddress, status: 'CONNECTED' };
    }
    const id = newId();
    await db.insert('tbl_user_mail_account', {
      id,
      userId,
      provider,
      emailAddress,
      encryptedTokens,
      status: 'CONNECTED',
    });
    return { id, provider, emailAddress, status: 'CONNECTED' };
  },

  async disconnect(userId: string, accountId: string) {
    const row = await db.select('tbl_user_mail_account', '*', 'id = ? AND userId = ?', [
      accountId,
      userId,
    ]);
    if (!row) throw new AppError('Mail account not found', 404);
    await db.delete('tbl_user_mail_account', 'id = ?', [accountId]);
    return { deleted: true };
  },

  getDecryptedTokens(account: { encryptedTokens: string }) {
    return decryptJson<Record<string, unknown>>(account.encryptedTokens);
  },
};

export const sendService = {
  async startSend(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    batchId: string,
    input: {
      mode: 'GENERATE_ONLY' | 'CREATE_DRAFTS' | 'SEND_NOW';
      subject?: string;
      bodyHtml?: string;
      confirmSendCount?: number;
      mailAccountId?: string;
    }
  ) {
    const batch = await batchService.get(organizationId, batchId);
    const limits = PLAN_LIMITS[plan];

    if (input.mode === 'GENERATE_ONLY') {
      await orgScope.update(
        organizationId,
        'tbl_letter_batch',
        { sendMode: 'GENERATE_ONLY' },
        'id = ?',
        [batchId]
      );
      return { mode: 'GENERATE_ONLY', message: 'No email will be sent.' };
    }

    if (!limits.letterSendingEnabled) {
      throw new AppError(
        'Email sending is not available on the FREE plan. Upgrade to PRO to send letters.',
        403
      );
    }

    if (!input.mailAccountId) {
      throw new AppError('Connect Outlook or Gmail and select a mail account first.', 400);
    }

    const account = await db.select(
      'tbl_user_mail_account',
      '*',
      'id = ? AND userId = ? AND status = ?',
      [input.mailAccountId, userId, 'CONNECTED']
    );
    if (!account) throw new AppError('Mail account not found or not connected', 404);

    const employees = await db.queryAll<any>(
      `SELECT id FROM tbl_letter_batch_employee
        WHERE batchId = ? AND pdfKey IS NOT NULL AND pdfKey <> ''
          AND validationStatus IN ('READY', 'WARNING')`,
      [batchId]
    );

    if (!employees.length) {
      throw new AppError('No generated PDFs available to send. Generate first.', 400);
    }

    if (input.mode === 'SEND_NOW') {
      if (input.confirmSendCount !== employees.length) {
        throw new AppError(
          `Send-now requires confirmSendCount=${employees.length} (exact recipient count).`,
          400
        );
      }
    }

    const subject = input.subject || `Your letter from organization`;
    const bodyHtml =
      input.bodyHtml ||
      `<p>Please find your letter attached.</p><p>This message was sent from your connected ${account.provider} account.</p>`;

    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      { sendMode: input.mode, status: 'SENDING' },
      'id = ?',
      [batchId]
    );

    await writeLetterAudit(organizationId, userId, 'BATCH_SEND_STARTED', 'letter_batch', batchId, {
      mode: input.mode,
      recipientCount: employees.length,
      provider: account.provider,
      // Never log passwords or tokens
    });

    const ids = employees.map((e: any) => e.id as string);
    const chunkSize = 20;
    for (let i = 0; i < ids.length; i += chunkSize) {
      await enqueueLetterSend(
        {
          batchId,
          organizationId,
          employeeIds: ids.slice(i, i + chunkSize),
          mode: input.mode === 'SEND_NOW' ? 'SEND_NOW' : 'CREATE_DRAFTS',
          subject,
          bodyHtml,
          userId,
          mailAccountId: account.id,
        },
        Math.floor(i / chunkSize)
      );
    }

    return {
      mode: input.mode,
      queued: ids.length,
      provider: account.provider,
      from: account.emailAddress,
    };
  },
};
