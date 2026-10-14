/**
 * Creates the private buckets if they are missing and sets their CORS rules, so the portal can reach them directly:
 * - ad uploads: upload (PUT) and play back (GET);
 * - licence documents (phase 5a): upload (PUT) only; a super admin opens one through a 5-minute link (P5A design §3.1);
 * - station logos (phase 5a): upload (PUT), and show (GET) through short links.
 * Run once per environment:
 *
 *   npm run object-storage:prepare
 *
 * In production this runs with a short-lived R2 "Admin Read & Write" token, which is revoked
 * afterwards; the running API holds only an "Object Read & Write" token for the one bucket, so it can
 * never change CORS or delete buckets.
 */
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client, type CORSRule } from '@aws-sdk/client-s3';
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
  const origins = [...config.ALLOWED_BROWSER_ORIGINS];
  const buckets: Array<[string, CORSRule]> = [
    [config.OBJECT_STORAGE_AD_UPLOADS_BUCKET, {
      AllowedOrigins: origins,
      AllowedMethods: ['PUT', 'GET'],
      AllowedHeaders: ['Content-Type', 'Range'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
      MaxAgeSeconds: 3600,
    }],
    [config.OBJECT_STORAGE_LICENCE_DOCUMENTS_BUCKET, {
      AllowedOrigins: origins,
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['Content-Type'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    }],
    [config.OBJECT_STORAGE_STATION_LOGOS_BUCKET, {
      AllowedOrigins: origins,
      AllowedMethods: ['PUT', 'GET'],
      AllowedHeaders: ['Content-Type'],
      ExposeHeaders: ['ETag', 'Content-Length'],
      MaxAgeSeconds: 3600,
    }],
  ];
  try {
    for (const [bucket, corsRule] of buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
      await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [corsRule] } }));
    }
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareObjectStorage()
    .then(() => console.log('Object storage is ready: private buckets with CORS for the portal.'))
    .catch((error: unknown) => {
      console.error('Could not prepare object storage:', error instanceof Error ? error.name : 'unknown error');
      process.exit(1);
    });
}
