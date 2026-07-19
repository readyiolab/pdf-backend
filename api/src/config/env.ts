import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env
dotenv.config();

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
  // bcrypt cost factor (higher = slower/safer). 12 is a good production default.
  BCRYPT_ROUNDS: z.coerce.number().min(10).max(15).default(12),

  // Comma-separated list of allowed browser origins for CORS
  CORS_ORIGINS: z.string().default('http://localhost:5174,http://localhost:5000'),
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
  SMTP_PORT: z.coerce.number().default(465),
  // true = implicit TLS (465). false = STARTTLS (587). Never plaintext:
  // these messages carry signing links, which are bearer credentials.
  SMTP_SECURE: z.coerce.boolean().default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Envelope From. Note Gmail IGNORES this and rewrites it to SMTP_USER unless
  // the address is a verified "send as" alias on that account.
  SMTP_FROM: z.string().optional(),

  // Public base URL of the FRONTEND, used to build signing links
  // (`${APP_URL}/sign/<token>`). Must be the address recipients can actually
  // reach — defaulting to localhost in production would mail out dead links.
  APP_URL: z.string().url().default('http://localhost:5174'),

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
  TSA_ENABLED: z.coerce.boolean().default(true),

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
