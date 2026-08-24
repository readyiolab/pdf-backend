import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { redis } from '../../lib/redis';
import { AppError } from '../../middleware/errorHandler.middleware';
import { encryptJson, decryptJson, isSecretBoxConfigured } from '../../lib/secretBox';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { writeLetterAudit } from '../orgs/orgs.service';
import { batchService } from './batch.service';
import { enqueueLetterSend } from '../../lib/letterQueues';
import { orgScope } from './orgScope';
import { logger } from '../../lib/logger';
import { fetchWithTimeout } from '../../lib/httpFetch';
import { recordCustomerEvent, upsertContact } from '../../lib/customerTracking';

function newId() {
  return crypto.randomUUID();
}

function oauthRedirectUri() {
  return `${String(env.APP_URL || '').replace(/\/$/, '')}/letters/mail/callback`;
}

const OAUTH_STATE_TTL_SEC = 600;

type MailProvider = 'OUTLOOK' | 'GMAIL';

type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
};

export const mailAccountService = {
  async list(userId: string) {
    const rows = await db.selectAll(
      'tbl_user_mail_account',
      'id, provider, emailAddress, status, createdAt, updatedAt',
      'userId = ?',
      [userId],
      'ORDER BY createdAt DESC'
    );
    return rows;
  },

  /** Build OAuth authorize URL for Microsoft or Google. */
  async getAuthorizeUrl(
    provider: MailProvider,
    userId: string,
    stateNonce: string
  ): Promise<string> {
    const redirectUri = oauthRedirectUri();
    const state = Buffer.from(JSON.stringify({ userId, provider, nonce: stateNonce })).toString(
      'base64url'
    );

    await redis.set(
      `letter-mail-oauth:${userId}:${stateNonce}`,
      provider,
      'EX',
      OAUTH_STATE_TTL_SEC
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
    const scopes = encodeURIComponent(
      'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email'
    );
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&access_type=offline&prompt=consent&state=${state}`;
  },

  async exchangeOAuthCode(userId: string, code: string, stateRaw: string) {
    let state: { userId?: string; provider?: string; nonce?: string };
    try {
      state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('Invalid OAuth state', 400);
    }

    if (state.userId !== userId || !state.nonce) {
      throw new AppError('OAuth state does not match the signed-in user', 403);
    }
    const provider = String(state.provider || '').toUpperCase() as MailProvider;
    if (provider !== 'OUTLOOK' && provider !== 'GMAIL') {
      throw new AppError('Unsupported mail provider', 400);
    }

    const stateKey = `letter-mail-oauth:${userId}:${state.nonce}`;
    const stored = await redis.get(stateKey);
    if (!stored || stored !== provider) {
      throw new AppError('OAuth session expired. Please connect again.', 400);
    }
    await redis.del(stateKey);

    const tokens =
      provider === 'OUTLOOK'
        ? await exchangeMicrosoftCode(code)
        : await exchangeGoogleCode(code);
    const emailAddress =
      provider === 'OUTLOOK'
        ? await fetchMicrosoftEmail(tokens.access_token)
        : await fetchGoogleEmail(tokens.access_token);

    return this.upsertFromOAuth(userId, provider, tokens, emailAddress);
  },

  async upsertFromOAuth(
    userId: string,
    provider: MailProvider,
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
    const encryptedTokens = encryptJson(withExpiry(tokens as OAuthTokens));
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
    return decryptJson<OAuthTokens>(account.encryptedTokens);
  },

  /**
   * Refresh access token when near expiry; persist updated tokens.
   * Returns a usable access_token.
   */
  async getValidAccessToken(account: {
    id: string;
    provider: string;
    encryptedTokens: string;
  }): Promise<string> {
    let tokens = this.getDecryptedTokens(account);
    const expiresAt = Number(tokens.expires_at || 0);
    const stillValid = expiresAt > Date.now() + 60_000;
    if (stillValid && tokens.access_token) {
      return String(tokens.access_token);
    }

    if (!tokens.refresh_token) {
      if (tokens.access_token) return String(tokens.access_token);
      throw new Error('Mail account tokens expired. Reconnect Outlook or Gmail.');
    }

    try {
      tokens =
        account.provider === 'OUTLOOK'
          ? await refreshMicrosoftToken(String(tokens.refresh_token))
          : await refreshGoogleToken(String(tokens.refresh_token), tokens);
      const encryptedTokens = encryptJson(withExpiry(tokens));
      await db.update('tbl_user_mail_account', { encryptedTokens }, 'id = ?', [account.id]);
      return String(tokens.access_token);
    } catch (err) {
      logger.warn(
        { accountId: account.id, err: (err as Error).message },
        'Mail token refresh failed'
      );
      throw new Error('Mail account tokens expired. Reconnect Outlook or Gmail.');
    }
  },
};

function withExpiry(tokens: OAuthTokens): OAuthTokens {
  const expiresIn = Number(tokens.expires_in || 3600);
  return {
    ...tokens,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

async function exchangeMicrosoftCode(code: string): Promise<OAuthTokens> {
  const clientId = env.MICROSOFT_CLIENT_ID || '';
  const clientSecret = env.MICROSOFT_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    throw new AppError('Microsoft OAuth is not configured on the server', 503);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: oauthRedirectUri(),
    grant_type: 'authorization_code',
  });
  const resp = await fetchWithTimeout(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    15_000
  );
  if (!resp.ok) {
    throw new AppError(`Microsoft token exchange failed: ${await resp.text()}`, 400);
  }
  return (await resp.json()) as OAuthTokens;
}

async function refreshMicrosoftToken(refreshToken: string): Promise<OAuthTokens> {
  const clientId = env.MICROSOFT_CLIENT_ID || '';
  const clientSecret = env.MICROSOFT_CLIENT_SECRET || '';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetchWithTimeout(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    15_000
  );
  if (!resp.ok) throw new Error(`Microsoft refresh failed: ${resp.status}`);
  const next = (await resp.json()) as OAuthTokens;
  if (!next.refresh_token) next.refresh_token = refreshToken;
  return next;
}

async function fetchMicrosoftEmail(accessToken: string): Promise<string> {
  const resp = await fetchWithTimeout(
    'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    15_000
  );
  if (!resp.ok) throw new AppError('Could not read Outlook profile', 400);
  const data = (await resp.json()) as { mail?: string; userPrincipalName?: string };
  const email = String(data.mail || data.userPrincipalName || '').trim();
  if (!email) throw new AppError('Outlook account has no email address', 400);
  return email;
}

async function exchangeGoogleCode(code: string): Promise<OAuthTokens> {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    throw new AppError('Google OAuth is not configured on the server', 503);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: oauthRedirectUri(),
    grant_type: 'authorization_code',
  });
  const resp = await fetchWithTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    15_000
  );
  if (!resp.ok) {
    throw new AppError(`Google token exchange failed: ${await resp.text()}`, 400);
  }
  return (await resp.json()) as OAuthTokens;
}

async function refreshGoogleToken(
  refreshToken: string,
  previous: OAuthTokens
): Promise<OAuthTokens> {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret || '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetchWithTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    15_000
  );
  if (!resp.ok) throw new Error(`Google refresh failed: ${resp.status}`);
  const next = (await resp.json()) as OAuthTokens;
  next.refresh_token = next.refresh_token || previous.refresh_token || refreshToken;
  return next;
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const resp = await fetchWithTimeout(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    15_000
  );
  if (!resp.ok) throw new AppError('Could not read Gmail profile', 400);
  const data = (await resp.json()) as { email?: string };
  const email = String(data.email || '').trim();
  if (!email) throw new AppError('Gmail account has no email address', 400);
  return email;
}

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

    // Customer tracking — best-effort contacts + letter_sent
    void (async () => {
      try {
        const rows = await db.queryAll<any>(
          `SELECT employeeDataJson FROM tbl_letter_batch_employee
            WHERE batchId = ? AND id IN (${ids.map(() => '?').join(',')})`,
          [batchId, ...ids]
        );
        for (const row of rows) {
          let data: Record<string, string> = {};
          try {
            data =
              typeof row.employeeDataJson === 'string'
                ? JSON.parse(row.employeeDataJson || '{}')
                : (row.employeeDataJson as any) || {};
          } catch {
            data = {};
          }
          const email = String(data.Employee_Email || '').trim();
          const name = String(data.Employee_Name || '').trim() || null;
          if (!email) continue;
          const contactId = await upsertContact({
            email,
            name,
            source: 'letter',
          });
          if (contactId) {
            await recordCustomerEvent({
              type: 'letter_sent',
              userId,
              contactId,
              meta: { batchId, mode: input.mode },
            });
          }
        }
        await recordCustomerEvent({
          type: 'letter_sent',
          userId,
          meta: { batchId, mode: input.mode, recipientCount: ids.length },
        });
      } catch (err) {
        logger.warn({ err, batchId, userId }, 'Failed to record letter_sent tracking');
      }
    })();

    return {
      mode: input.mode,
      queued: ids.length,
      provider: account.provider,
      from: account.emailAddress,
    };
  },
};
