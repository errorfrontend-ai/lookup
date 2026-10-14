import { Injectable } from '@nestjs/common';
import { MINIMUM_STATION_LOGO_PIXELS } from '@lookup/contracts';
import sharp from 'sharp';
import { AppError } from '../../common/errors/app-error.js';

/** The stored logo fits inside this square, never enlarged (P5A-D14): one size suits the portal and the app's chooser. */
export const STATION_LOGO_LARGEST_SIDE = 512;
const WEBP_QUALITY = 85;
/** Refuse to decode anything larger, whatever its file size says (a decompression bomb). */
const LARGEST_INPUT_PIXELS = 25_000_000;
const MAXIMUM_CONCURRENT_PROCESSING = 2;
const MAXIMUM_WAIT_FOR_A_SLOT_MILLISECONDS = 5_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export type StationLogoProcessing =
  | { isProcessed: true; webp: Buffer; width: number; height: number }
  | { isProcessed: false; reason: 'wrong_file_type' | 'image_too_small' | 'image_unreadable' };

/** Whether the first bytes are a PNG's or a JPEG's signature: what the file is, whatever it was called. */
export function isPngOrJpeg(firstBytes: Buffer): boolean {
  return firstBytes.subarray(0, 8).equals(PNG_SIGNATURE) || firstBytes.subarray(0, 3).equals(JPEG_SIGNATURE);
}

/**
 * A station's logo as it is stored (P5A design §3.1, P5A-STATION-DETAILS-04..06): PNG or JPEG by its first bytes, at
 * least 64 × 64, decoded by sharp with a pixel limit and errors refused, turned upright by its EXIF orientation, its
 * metadata dropped, fitted inside 512 × 512 without enlarging, saved as WebP. The size limit is checked before this
 * runs, by the upload's signed length. At most two run at once per instance; a third waits up to 5 seconds, then is
 * answered SERVICE_UNAVAILABLE rather than piling up memory.
 */
@Injectable()
export class StationLogoProcessor {
  private activeCount = 0;
  private readonly waiting: Array<() => void> = [];

  async process(original: Buffer): Promise<StationLogoProcessing> {
    if (!isPngOrJpeg(original)) return { isProcessed: false, reason: 'wrong_file_type' };
    await this.takeSlot();
    try {
      return await processStationLogoNow(original);
    } finally {
      this.activeCount -= 1;
      this.waiting.shift()?.();
    }
  }

  private takeSlot(): Promise<void> {
    if (this.activeCount < MAXIMUM_CONCURRENT_PROCESSING) {
      this.activeCount += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        clearTimeout(giveUp);
        this.activeCount += 1;
        resolve();
      };
      const giveUp = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(start), 1);
        reject(new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'logo processing is at capacity' }));
      }, MAXIMUM_WAIT_FOR_A_SLOT_MILLISECONDS);
      this.waiting.push(start);
    });
  }
}

async function processStationLogoNow(original: Buffer): Promise<StationLogoProcessing> {
  try {
    const decoder = () => sharp(original, { limitInputPixels: LARGEST_INPUT_PIXELS, failOn: 'error' });
    const facts = await decoder().metadata();
    // The orientation swaps the sides of a rotated photo; either way both must reach the minimum.
    if ((facts.width ?? 0) < MINIMUM_STATION_LOGO_PIXELS || (facts.height ?? 0) < MINIMUM_STATION_LOGO_PIXELS) {
      return { isProcessed: false, reason: 'image_too_small' };
    }
    const { data, info } = await decoder()
      .rotate()
      .resize({ width: STATION_LOGO_LARGEST_SIDE, height: STATION_LOGO_LARGEST_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { isProcessed: true, webp: data, width: info.width, height: info.height };
  } catch {
    return { isProcessed: false, reason: 'image_unreadable' };
  }
}
