export interface ParsedFrequency {
  band: 'FM' | 'AM';
  /** The number as written, "98.1" or "1260". */
  numberText: string;
  value: number;
}

/** The FM band as the dial draws it, in MHz. */
export const FM_BAND_START = 87.5;
export const FM_BAND_END = 108;

/**
 * Reads a station's frequency label ("98.1 FM", "89.5 fm", "1260 AM"). Returns null when it isn't a
 * frequency we can place on a dial; the portal then just shows the label as written.
 */
export function parseFrequencyLabel(label: string): ParsedFrequency | null {
  const match = /^\s*(\d{2,4}(?:\.\d{1,2})?)\s*(FM|AM)\s*$/i.exec(label);
  if (!match) return null;
  const numberText = match[1] as string;
  const band = (match[2] as string).toUpperCase() as 'FM' | 'AM';
  const value = Number(numberText);
  if (band === 'FM' && (value < FM_BAND_START || value > FM_BAND_END)) return null;
  return { band, numberText, value };
}
