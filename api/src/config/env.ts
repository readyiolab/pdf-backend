import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env
dotenv.config();

/**
 * Env vars are always strings. z.coerce.boolean() wrongly turns "false" → true
 * (Boolean("false") === true). Parse true/false/1/0/yes/no properly.
 */
const envBool = (defaultValue: boolean) =>
  z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return defaultValue;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    const s = String(val).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return defaultValue;
  }, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('pdf_saas'),
  DB_CONNECTION_LIMIT: z.coerce.number().default(10),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  GUEST_JWT_EXPIRES_IN: z.string().default('24h'),
  // bcrypt cost for user passwords (10 ≈ 100ms; 12 can feel sluggish on register/login).
  BCRYPT_ROUNDS: z.coerce.number().min(10).max(15).default(10),
  // Cheaper cost for short-lived OTP / access-code hashes (not long-lived passwords).
  BCRYPT_OTP_ROUNDS: z.coerce.number().min(4).max(10).default(6),

  // Comma-separated list of allowed browser origins for CORS
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:3000,http://localhost:5000,http://127.0.0.1:5173'
    ),
  // Max JSON request body size (protects against large-payload DoS)
  MAX_JSON_BODY: z.string().default('100kb'),
  // Max JSON body for the signing router only. A field-designer save posts the
  // document's whole field set at once, which legitimately exceeds the 100kb
  // global cap (SIGNING_LIMITS.maxFieldsPerDocument is 500). Kept as a separate
  // knob so raising it doesn't widen the DoS surface on every other endpoint.
  SIGNING_MAX_JSON_BODY: z.string().default('2mb'),
  // TTL (seconds) for signed download URLs handed to the job owner
  DOWNLOAD_URL_TTL: z.coerce.number().default(300),
  // How long a job's files are retained before the cleanup sweep removes them
  JOB_TTL_MINUTES: z.coerce.number().default(60),
  // TTL (seconds) for presigned upload URLs
  PRESIGN_TTL_SECONDS: z.coerce.number().default(900),
  // Admin token protecting the queue dashboard. If unset, the dashboard is disabled.
  ADMIN_TOKEN: z.string().optional(),

  // DigitalOcean Spaces
  DO_SPACES_KEY: z.string(),
  DO_SPACES_SECRET: z.string(),
  DO_SPACES_REGION: z.string().default('blr1'),
  DO_SPACES_BUCKET: z.string(),
  DO_SPACES_ENDPOINT: z.string().url(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // --- Email (SMTP) ---
  // Carries signing invitations and OTPs. All optional so the API still boots
  // without them; the mailer reports itself unconfigured and the send endpoint
  // fails loudly rather than the app dying at startup on a missing secret.
  SMTP_HOST: z.string().optional(),
  // SMTP2GO often uses 2525; Gmail/others use 587 (STARTTLS) or 465 (TLS).
  SMTP_PORT: z.coerce.number().default(2525),
  // true = implicit TLS (465). false = STARTTLS / submission (587, 2525).
  // IMPORTANT: do not use z.coerce.boolean() — "false" would become true.
  SMTP_SECURE: envBool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Prefer SMTP_FROM; SMTP_FROM_EMAIL is accepted as an alias (common in other apps).
  SMTP_FROM: z.preprocess(
    (v) => (typeof v === 'string' && v.length > 0 ? v : process.env.SMTP_FROM_EMAIL),
    z.string().optional()
  ),
  ADMIN_EMAIL: z.string().email().optional(),

  // Public base URL of the FRONTEND, used to build signing links
  // (`${APP_URL}/sign/<token>`). Must be the address recipients can actually
  // reach — defaulting to localhost in production would mail out dead links.
  APP_URL: z.string().url().default('http://localhost:5174'),

  // Google Identity Services — Client ID is the JWT audience for ID-token login.
  // Client secret is optional here (unused for GIS ID tokens; kept for future
  // Google API / OAuth code flows such as Drive).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // AES-256 key for encrypting BYOC storage credentials at rest.
  // 32 bytes as base64 (44 chars) or 64-char hex. Generate: openssl rand -base64 32
  INFRA_CREDENTIALS_KEY: z.string().optional(),
  // Previous key during rotation — decrypt tries current then previous.
  INFRA_CREDENTIALS_KEY_PREVIOUS: z.string().optional(),

  // Comma-separated emails treated as platform admins for the Admin app
  // (in addition to tbl_user.isPlatformAdmin = 1).
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
  // Optional comma-separated CIDR/IP allowlist for Admin API access.
  PLATFORM_ADMIN_IP_ALLOWLIST: z.string().optional(),
  // Admin JWT TTL (shorter than customer sessions).
  ADMIN_JWT_EXPIRES_IN: z.string().default('8h'),
  // Allow http:// BYOC endpoints (self-hosted MinIO) even in production.
  BYOC_ALLOW_INSECURE_ENDPOINTS: envBool(false),

  // Optional bootstrap for the Admin app. Leave unset in production unless
  // you intentionally want API boot to create/update a platform admin.
  SEED_PLATFORM_ADMIN_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().email().optional()
  ),
  SEED_PLATFORM_ADMIN_PASSWORD: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(8).optional()
  ),
  SEED_PLATFORM_ADMIN_NAME: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional()
  ),

  // --- Digital signature (PAdES/PKCS#7) ---
  // The signing certificate applied to the finished PDF so any later edit
  // breaks the signature (tamper-evidence) in Adobe / any PDF reader.
  //   - Production: supply a real cert as base64-encoded PKCS#12 in
  //     SIGNING_P12_BASE64 (+ its passphrase). An AATL-chained cert shows a
  //     green check in Adobe; anything else shows valid-but-untrusted.
  //   - Dev / unset: a self-signed cert is generated once and cached at
  //     SIGNING_CERT_PATH, reused across restarts. Tamper-evidence still works;
  //     readers just won't trust the (unknown) issuer.
  SIGNING_P12_BASE64: z.string().optional(),
  SIGNING_P12_PASSPHRASE: z.string().default(''),
  SIGNING_CERT_PATH: z.string().default('./signing-cert.p12'),

  // RFC 3161 Timestamp Authority. Stamps the final document's hash with an
  // INDEPENDENT, verifiable time so the signing moment isn't only our word.
  // Best-effort: if unreachable, the signature is still applied and the
  // document's own completedAt stands. freetsa.org is a free public TSA.
  TSA_URL: z.string().url().default('https://freetsa.org/tsr'),
  TSA_ENABLED: envBool(true),

  // Optional Microsoft Graph (Outlook) OAuth for Letter Studio sending
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  // --- AI (OpenAI) ---
  // Powers Chat/Summarize/Explain over PDFs. Optional so the API still boots
  // without it; the AI service reports itself unconfigured and its endpoints
  // fail loudly (503) rather than the app dying at startup. Every call costs
  // money per token — quota is enforced separately (PLAN_LIMITS.maxMonthlyAiCredits).
  //
  // Provider-abstracted (see lib/ai/): AI_PROVIDER selects the backend. OpenAI
  // is the active provider; a Claude provider can be added without touching the
  // AI service. We extract the PDF's text server-side and send text, so this
  // works with any OpenAI chat model regardless of file-input API support.
  AI_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  // Model id — set one your key has access to. gpt-4o-mini is the cheapest
  // capable tier for high-volume PDF Q&A; swap here for more capability.
  // Also used by Diagram AI (text + vision). Prefer a vision-capable model
  // (e.g. gpt-4o-mini / gpt-4o) for image-to-diagram.
  AI_MODEL: z.string().default('gpt-4o-mini'),
  // Hard ceiling on extracted document text sent to the model (characters).
  // ~4 chars/token, so 400k ≈ 100k tokens — within a 128k context with room
  // for the answer, and a guard against a huge PDF blowing up cost.
  AI_MAX_TEXT_CHARS: z.coerce.number().default(400_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables in api:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
