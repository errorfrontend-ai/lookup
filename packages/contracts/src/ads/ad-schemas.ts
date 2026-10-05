import { z } from 'zod';

/** The audio types a station may upload, in their canonical form (the only Content-Type the API signs for). */
export const AD_UPLOAD_CONTENT_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4'] as const;
export type AdUploadContentType = (typeof AD_UPLOAD_CONTENT_TYPES)[number];

export const MAXIMUM_AD_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
export const MAXIMUM_AD_TITLE_LENGTH = 120;
export const MAXIMUM_UPLOAD_FILE_NAME_LENGTH = 255;
/** Ads shorter or longer than this are refused when the audio is processed (Step 3 checks the decoded length). */
export const MINIMUM_AD_DURATION_SECONDS = 5;
export const MAXIMUM_AD_DURATION_SECONDS = 120;

export const AD_STATUSES = ['AWAITING_UPLOAD', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED'] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

const EXTENSION_CONTENT_TYPES: Record<string, AdUploadContentType> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
};
const BROWSER_CONTENT_TYPES: Record<string, AdUploadContentType> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp4': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/aac': 'audio/mp4',
};

/**
 * The canonical type for a file a station picked, from what the browser reports or, when the browser
 * reports nothing useful, the file's extension. Null when it is not one of the accepted formats. The
 * API checks the file's first bytes after upload, so this decides only which type the upload is
 * signed for.
 */
export function canonicalAdContentType(fileName: string, browserReportedType: string): AdUploadContentType | null {
  const fromBrowser = BROWSER_CONTENT_TYPES[browserReportedType.trim().toLowerCase()];
  if (fromBrowser) return fromBrowser;
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1]?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPES[extension] ?? null;
}

export const UploadRequest = z.strictObject({
  fileName: z.string().trim().min(1).max(MAXIMUM_UPLOAD_FILE_NAME_LENGTH),
  contentType: z.enum(AD_UPLOAD_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAXIMUM_AD_UPLOAD_SIZE_BYTES),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const CreateAdInput = z.strictObject({
  clientId: z.uuid(),
  title: z.string().trim().min(1).max(MAXIMUM_AD_TITLE_LENGTH),
  upload: UploadRequest,
});
export type CreateAdInput = z.infer<typeof CreateAdInput>;

export const RequestUploadUrlInput = z.strictObject({ upload: UploadRequest });
export type RequestUploadUrlInput = z.infer<typeof RequestUploadUrlInput>;

/** Where and how the browser sends the file: exactly these headers, or the storage refuses it. */
export interface UploadInstructions {
  method: 'PUT';
  url: string;
  headers: { 'Content-Type': AdUploadContentType };
  expiresAt: string;
}

export interface CreatedAd {
  adId: string;
  upload: UploadInstructions;
}

export const CAMPAIGN_DISPLAY_STATUSES = ['DRAFT', 'SCHEDULED', 'LIVE_NOW', 'PAUSED', 'ENDED'] as const;
export type CampaignDisplayStatus = (typeof CAMPAIGN_DISPLAY_STATUSES)[number];

export interface AdCampaignSummary {
  id: string;
  /** Worked out in the station's time zone: Draft, Scheduled (not started or between windows), Live now, Paused, Ended. */
  displayStatus: CampaignDisplayStatus;
  /** First and last day it airs, station-local "YYYY-MM-DD". */
  startsOn: string;
  endsOn: string;
  timeWindows: Array<{ daysOfWeek: number[]; localStartTime: string; localEndTime: string }>;
}

export interface AdSummary {
  id: string;
  title: string;
  client: { id: string; name: string };
  status: AdStatus;
  durationMilliseconds: number | null;
  uploadedFileName: string | null;
  campaign: AdCampaignSummary | null;
  updatedAt: string;
}

export interface AdListPage {
  ads: AdSummary[];
  /** Pass back as ?cursor= for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface AdPlaybackUrl {
  url: string;
  expiresAt: string;
}
