/**
 * Creates the private ad-uploads bucket if it is missing and sets its CORS rules, so the portal can
 * upload (PUT) and play back (GET) files directly. Run once per environment:
 *
 *   npm run object-storage:prepare
 *
 * In production this runs with a short-lived R2 "Admin Read & Write" token, which is revoked
 * afterwards; the running API holds only an "Object Read & Write" token for the one bucket, so it can
 * never change CORS or delete buckets.
 */
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { loadAppConfig } from '../src/config/app-config.js';

export async function prepareObjectStorage(): Promise<void> {
  const environmentFile = new URL('../.env', import.meta.url);
  try {
    process.loadEnvFile(environmentFile);
  } catch {
    // Real environment variables are used when there is no .env file (CI, deploys).
  }
  const config = loadAppConfig();
  const client = new S3Client({
    region: config.OBJECT_STORAGE_REGION,
    endpoint: config.OBJECT_STORAGE_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY_ID, secretAccessKey: config.OBJECT_STORAGE_SECRET_ACCESS_KEY },
  });
  const bucket = config.OBJECT_STORAGE_AD_UPLOADS_BUCKET;
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...config.ALLOWED_BROWSER_ORIGINS],
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['Content-Type', 'Range'],
              ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareObjectStorage()
    .then(() => console.log('Object storage is ready: private bucket with CORS for the portal.'))
    .catch((error: unknown) => {
      console.error('Could not prepare object storage:', error instanceof Error ? error.name : 'unknown error');
      process.exit(1);
    });
}
