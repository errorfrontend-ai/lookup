import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

export interface StoredObjectFacts {
  sizeBytes: number;
  contentType: string | null;
  entityTag: string;
}

/**
 * The ad-uploads bucket (Cloudflare R2 in production, versitygw locally).
 *
 * Two clients: `internal` for the API's own requests, and `public` only for signing URLs a browser
 * will use, because a presigned URL's signature covers the host name.
 *
 * Both turn off the SDK's automatic checksums ('WHEN_REQUIRED'): otherwise the SDK signs a CRC32 of
 * the EMPTY body into every presigned upload URL, and real uploads then fail.
 */
@Injectable()
export class ObjectStorage implements OnApplicationShutdown {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  readonly adUploadsBucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const commonSettings = {
      region: config.OBJECT_STORAGE_REGION,
      credentials: { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY_ID, secretAccessKey: config.OBJECT_STORAGE_SECRET_ACCESS_KEY },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      maxAttempts: 2,
    };
    this.internalClient = new S3Client({ ...commonSettings, endpoint: config.OBJECT_STORAGE_ENDPOINT });
    this.publicClient = new S3Client({ ...commonSettings, endpoint: config.OBJECT_STORAGE_PUBLIC_ENDPOINT });
    this.adUploadsBucket = config.OBJECT_STORAGE_AD_UPLOADS_BUCKET;
  }

  /**
   * A URL the browser PUTs the file to. Content-Type and Content-Length are part of the signature, so a
   * different type or a different number of bytes is refused by the storage itself (R2 has no POST
   * policy, so this is how the size limit is enforced). The browser sets Content-Length from the file;
   * scripts cannot change it.
   */
  createUploadUrl(objectKey: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  /** A short-lived URL to play an uploaded file in the browser. */
  createPlaybackUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey }), {
      expiresIn: expiresInSeconds,
    });
  }

  /** Size, type and entity tag of a stored object; null when there is no such object. */
  async describeObject(objectKey: string): Promise<StoredObjectFacts | null> {
    try {
      const head = await this.internalClient.send(new HeadObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey }));
      return { sizeBytes: Number(head.ContentLength ?? -1), contentType: head.ContentType ?? null, entityTag: head.ETag ?? '' };
    } catch (error) {
      if (error instanceof NotFound || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return null;
      throw error;
    }
  }

  /** The first bytes of the exact version described (If-Match), to check what the file really is. */
  async readFirstBytes(objectKey: string, entityTag: string, byteCount: number): Promise<Buffer> {
    const response = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey, Range: `bytes=0-${byteCount - 1}`, IfMatch: entityTag }),
    );
    return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.internalClient.send(new DeleteObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey }));
  }

  onApplicationShutdown(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }
}
