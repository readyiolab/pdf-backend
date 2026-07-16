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
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5000'),
  // Max JSON request body size (protects against large-payload DoS)
  MAX_JSON_BODY: z.string().default('100kb'),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables in api:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
