import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env';

export const s3 = new S3Client({
  endpoint: env.DO_SPACES_ENDPOINT,
  region: env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: env.DO_SPACES_KEY,
    secretAccessKey: env.DO_SPACES_SECRET,
  },
  forcePathStyle: false, // Required for DigitalOcean Spaces virtual hosting
});
