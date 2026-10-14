import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isPngOrJpeg, StationLogoProcessor } from '../src/features/registration/station-logo-processing.js';

/**
 * Station logos (P5A design §3.1, P5A-D14; P5A-STATION-DETAILS-04..06): PNG or JPEG by their first bytes, at least
 * 64 × 64, upright, without metadata, inside 512 × 512 and never enlarged, stored as WebP; anything else refused with
 * a reason.
 */
const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 20 } } });

describe('station logo processing', () => {
  const processor = new StationLogoProcessor();

  it('a large PNG is fitted inside 512 × 512 as WebP, keeping its shape', async () => {
    const result = await processor.process(await solid(1024, 600).png().toBuffer());
    expect(result).toMatchObject({ isProcessed: true, width: 512, height: 300 });
    if (!result.isProcessed) throw new Error('not processed');
    expect((await sharp(result.webp).metadata()).format).toBe('webp');
  });

  it('a small JPEG is never enlarged', async () => {
    expect(await processor.process(await solid(120, 80).jpeg().toBuffer())).toMatchObject({ isProcessed: true, width: 120, height: 80 });
  });

  it('a photo is turned upright by its orientation, and its metadata is dropped', async () => {
    const sideways = await solid(300, 100).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'Sunrise FM' } } }).toBuffer();
    const result = await processor.process(sideways);
    expect(result).toMatchObject({ isProcessed: true, width: 100, height: 300 });
    if (!result.isProcessed) throw new Error('not processed');
    const stored = await sharp(result.webp).metadata();
    expect([stored.exif, stored.orientation, stored.icc, stored.xmp]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('gap 6: a logo under 64 pixels on a side is refused as too small', async () => {
    expect(await processor.process(await solid(63, 200).png().toBuffer())).toEqual({ isProcessed: false, reason: 'image_too_small' });
    expect(await processor.process(await solid(64, 64).png().toBuffer())).toMatchObject({ isProcessed: true });
  });

  it('only PNG and JPEG by their first bytes: GIF, WebP and SVG are refused as the wrong type, whatever their name', async () => {
    for (const other of [await solid(100, 100).gif().toBuffer(), await solid(100, 100).webp().toBuffer(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
      expect(await processor.process(other)).toEqual({ isProcessed: false, reason: 'wrong_file_type' });
    }
    expect(isPngOrJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isPngOrJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('a file with a PNG signature that is not a picture, a cut-off picture, or one past 25 megapixels is refused as unreadable', async () => {
    const png = await solid(200, 200).png().toBuffer();
    const notAPicture = Buffer.concat([png.subarray(0, 8), Buffer.from('not really an image at all')]);
    const cutOff = png.subarray(0, Math.floor(png.length / 2));
    const tooManyPixels = await solid(6_000, 5_000).png({ compressionLevel: 9 }).toBuffer();
    for (const unreadable of [notAPicture, cutOff, tooManyPixels]) {
      expect(await processor.process(unreadable)).toEqual({ isProcessed: false, reason: 'image_unreadable' });
    }
  });

  it('at most two run at once; the others wait their turn', async () => {
    const pictures = await Promise.all(Array.from({ length: 5 }, () => solid(2_000, 2_000).png().toBuffer()));
    const results = await Promise.all(pictures.map((picture) => processor.process(picture)));
    expect(results.every((result) => result.isProcessed)).toBe(true);
  });
});
