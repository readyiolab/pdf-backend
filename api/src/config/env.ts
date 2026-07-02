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
  JWT_SECRET: z.string().min(8),
  
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
