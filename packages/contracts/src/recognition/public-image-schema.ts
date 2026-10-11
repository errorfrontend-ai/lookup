import { z } from 'zod';

/**
 * An image a listener's phone downloads: where, its size in pixels and in bytes (for data saving).
 * It has a file of its own so the station and the recognize schemas can both use it without importing
 * each other.
 */
export const PublicImage = z
  .strictObject({
    address: z.string().max(2048).regex(/^https:\/\/[^\s/?#]+[^\s]*$/),
    width_pixels: z.number().int().min(1).max(4096),
    height_pixels: z.number().int().min(1).max(4096),
    size_bytes: z.number().int().min(1),
  })
  .meta({ id: 'PublicImage' });
export type PublicImage = z.infer<typeof PublicImage>;
