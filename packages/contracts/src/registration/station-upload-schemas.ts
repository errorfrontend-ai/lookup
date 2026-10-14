import { z } from 'zod';

/**
 * Files a station sends with its application (design §3.2): a logo and the broadcasting licence. The
 * browser asks for a signed upload address, sends the file straight to the private bucket, then asks
 * the API to check it. The signature fixes the type and size; the API checks the file's first bytes.
 */

/** Logos: PNG or JPG only (SignupStation wireframe "Add logo · PNG or JPG"), at most 2 MB, at least 64 × 64 px. */
export const STATION_LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
export type StationLogoContentType = (typeof STATION_LOGO_CONTENT_TYPES)[number];
export const MAXIMUM_STATION_LOGO_SIZE_BYTES = 2 * 1024 * 1024;
export const MINIMUM_STATION_LOGO_PIXELS = 64;

/** Licence documents: PDF or JPG (plan §A step 4), at most 5 MB. */
export const LICENCE_DOCUMENT_CONTENT_TYPES = ['application/pdf', 'image/jpeg'] as const;
export type LicenceDocumentContentType = (typeof LICENCE_DOCUMENT_CONTENT_TYPES)[number];
export const MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;

export const MAXIMUM_STATION_FILE_NAME_LENGTH = 120;

/** Why an uploaded file was refused; relayed as the reason of the "file" field. */
export const STATION_FILE_REFUSAL_REASONS = ['wrong_file_type', 'file_too_large', 'image_too_small', 'image_unreadable', 'upload_not_received'] as const;
export type StationFileRefusalReason = (typeof STATION_FILE_REFUSAL_REASONS)[number];

const FileName = z.string().trim().min(1).max(MAXIMUM_STATION_FILE_NAME_LENGTH);

/** POST …/logo-uploads */
export const StartStationLogoUploadInput = z.strictObject({
  fileName: FileName,
  contentType: z.enum(STATION_LOGO_CONTENT_TYPES),
  byteCount: z.int().min(1).max(MAXIMUM_STATION_LOGO_SIZE_BYTES),
});
export type StartStationLogoUploadInput = z.infer<typeof StartStationLogoUploadInput>;

/** POST …/licence-document-uploads */
export const StartLicenceDocumentUploadInput = z.strictObject({
  fileName: FileName,
  contentType: z.enum(LICENCE_DOCUMENT_CONTENT_TYPES),
  byteCount: z.int().min(1).max(MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES),
});
export type StartLicenceDocumentUploadInput = z.infer<typeof StartLicenceDocumentUploadInput>;

/** Where to send the file, and until when the address works. */
export interface StationUploadAddress {
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
}

/** What the applicant and the reviewer see of a licence document; its storage key is never sent to a station. */
export interface LicenceDocumentSummary {
  fileName: string;
  contentType: LicenceDocumentContentType;
  byteCount: number;
  uploadedAt: string;
}

const BROWSER_IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg'> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};
const EXTENSION_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'application/pdf'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};

/**
 * The type to sign an upload for, from what the browser reports or, when it reports nothing useful,
 * the file's extension; null when the file is not one of the types allowed for that purpose.
 */
export function contentTypeForStationFile(
  file: { type: string; name: string },
  purpose: 'logo' | 'licence-document',
): StationLogoContentType | LicenceDocumentContentType | null {
  const reported = file.type.trim().toLowerCase();
  const fromBrowser = reported === 'application/pdf' ? 'application/pdf' : BROWSER_IMAGE_TYPES[reported];
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const candidate = fromBrowser ?? (reported === '' || reported === 'application/octet-stream' ? EXTENSION_TYPES[extension] : undefined);
  if (candidate === undefined) return null;
  const allowed: readonly string[] = purpose === 'logo' ? STATION_LOGO_CONTENT_TYPES : LICENCE_DOCUMENT_CONTENT_TYPES;
  return allowed.includes(candidate) ? (candidate as StationLogoContentType | LicenceDocumentContentType) : null;
}
