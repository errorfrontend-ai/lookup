/** A tiny seeded random generator (mulberry32): the same seed always gives the same sequence. */
function createRandomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: turns text (an ad's id) into a number to seed the generator with. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Bar heights between 0.2 and 1 that look like a speech waveform and are the same every time for the
 * same ad. They are decoration, not the real audio, which the browser never has to download to draw them.
 */
export function waveformHeights(seed: string, count: number): number[] {
  const random = createRandomGenerator(hashText(seed));
  let previous = 0.5;
  return Array.from({ length: count }, () => {
    previous = Math.min(1, Math.max(0.2, previous * 0.55 + random() * 0.6));
    return Math.round(previous * 100) / 100;
  });
}

/** The waveform picture; the part already played is drawn in the accent colour. Hidden from screen readers. */
export function WaveformBars({ seed, progress = 0, count = 48, heights: realHeights }: { seed: string; progress?: number; count?: number; heights?: number[] | null }) {
  // Bars from the audio itself when we have them (a file just chosen), otherwise the ad's own made-up shape.
  const heights = realHeights && realHeights.length > 0 ? realHeights : waveformHeights(seed, count);
  const playedBars = Math.round(progress * heights.length);
  return (
    <div aria-hidden="true" className="flex h-10 flex-1 items-center gap-[3px]">
      {heights.map((height, index) => (
        <div key={index} style={{ height: `${height * 100}%` }} className={`flex-1 rounded-sm ${index < playedBars ? 'bg-accent' : 'bg-line'}`} />
      ))}
    </div>
  );
}
