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
  /** Phase 5a's private buckets (P5A design §3.1): licence documents (uploads only) and station logos. */
  readonly licenceDocumentsBucket: string;
  readonly stationLogosBucket: string;

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
    this.licenceDocumentsBucket = config.OBJECT_STORAGE_LICENCE_DOCUMENTS_BUCKET;
    this.stationLogosBucket = config.OBJECT_STORAGE_STATION_LOGOS_BUCKET;
  }

  /**
   * A URL the browser PUTs the file to. Content-Type and Content-Length are part of the signature, so a
   * different type or a different number of bytes is refused by the storage itself (R2 has no POST
   * policy, so this is how the size limit is enforced). The browser sets Content-Length from the file;
   * scripts cannot change it.
   */
  createUploadUrl(objectKey: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<string> {
    return this.createUploadUrlIn(this.adUploadsBucket, objectKey, contentType, sizeBytes, expiresInSeconds);
  }

  /** createUploadUrl for another of the private buckets. */
  createUploadUrlIn(bucket: string, objectKey: string, contentType: string, sizeBytes: number, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  /**
   * A short-lived URL a browser opens a stored file through (a licence document, a logo). The answer's type and an
   * inline disposition are fixed by the signature, so a stored file is never served as anything else, and never as a
   * page (P5A design §3.1). The file name shown is reduced to safe characters.
   */
  createDownloadUrlIn(bucket: string, objectKey: string, expiresInSeconds: number, shown: { contentType: string; fileName: string }): Promise<string> {
    const safeName = shown.fileName.normalize('NFKD').replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 120) || 'file';
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ResponseContentType: shown.contentType,
        ResponseContentDisposition: `inline; filename="${safeName}"`,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** A short-lived URL to play an uploaded file in the browser. */
  createPlaybackUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey }), {
      expiresIn: expiresInSeconds,
    });
  }

  /**
   * A short-lived URL a fingerprint worker downloads an upload through. It is signed for the internal
   * endpoint, which the workers reach (browsers get the public one), and it is the only way a worker
   * reaches storage: the workers hold no credentials.
   */
  createWorkerDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.internalClient, new GetObjectCommand({ Bucket: this.adUploadsBucket, Key: objectKey }), {
      expiresIn: expiresInSeconds,
    });
  }

  /** Size, type and entity tag of a stored object; null when there is no such object. */
  describeObject(objectKey: string): Promise<StoredObjectFacts | null> {
    return this.describeObjectIn(this.adUploadsBucket, objectKey);
  }

  /** describeObject for another of the private buckets. */
  async describeObjectIn(bucket: string, objectKey: string): Promise<StoredObjectFacts | null> {
    try {
      const head = await this.internalClient.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
      return { sizeBytes: Number(head.ContentLength ?? -1), contentType: head.ContentType ?? null, entityTag: head.ETag ?? '' };
    } catch (error) {
      if (error instanceof NotFound || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return null;
      throw error;
    }
  }

  /** The first bytes of the exact version described (If-Match), to check what the file really is. */
  readFirstBytes(objectKey: string, entityTag: string, byteCount: number): Promise<Buffer> {
    return this.readFirstBytesIn(this.adUploadsBucket, objectKey, entityTag, byteCount);
  }

  /** readFirstBytes for another of the private buckets. */
  async readFirstBytesIn(bucket: string, objectKey: string, entityTag: string, byteCount: number): Promise<Buffer> {
    const response = await this.internalClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey, Range: `bytes=0-${byteCount - 1}`, IfMatch: entityTag }),
    );
    return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
  }

  /** The whole of the exact version described (If-Match); for small files only (a logo is at most 2 MB, checked first). */
  async readObjectIn(bucket: string, objectKey: string, entityTag: string): Promise<Buffer> {
    const response = await this.internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey, IfMatch: entityTag }));
    return Buffer.from((await response.Body?.transformToByteArray()) ?? []);
  }

  /** Stores a file the API made itself (a processed logo). */
  async putObjectIn(bucket: string, objectKey: string, body: Buffer, contentType: string): Promise<void> {
    await this.internalClient.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType, ContentLength: body.length }));
  }

  deleteObject(objectKey: string): Promise<void> {
    return this.deleteObjectIn(this.adUploadsBucket, objectKey);
  }

  /** deleteObject for another of the private buckets. */
  async deleteObjectIn(bucket: string, objectKey: string): Promise<void> {
    await this.internalClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  }

  onApplicationShutdown(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }
}
