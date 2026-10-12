/**
 * A pleasant 20-second jingle as a valid WAV file (8 kHz, 16-bit, mono), made in code so the development sample ads
 * have real audio to play in the portal and to identify through the air, without downloading or storing a recording.
 *
 * It has what a radio jingle has (ADR-001, "Real captures, October 2026"): a melody, a chord under each bar and a
 * beat. Pure notes alone gave a phone too few landmarks to recognise through a speaker; every part here adds peaks
 * at its own frequencies and moments. Everything, the drum noise included, follows from the notes, so the same notes
 * always make the same bytes. The tempo (one of seven) and the kick's pitch follow from them too, so most sample ads
 * have a beat of their own; ads that share a tempo still differ in melody and chords, which carry most landmarks.
 */
const SAMPLE_RATE = 8_000;
const SECONDS = 20;
/** How long each melody note lasts, in beats; the pattern repeats. */
const MELODY_RHYTHM_BEATS: readonly number[] = [1, 0.5, 0.5, 1, 0.5, 0.5];

/**
 * The notes of the shared jingle, in hertz. "Summer service offer" airs on Station A and on Station B with this one
 * recording, so the fingerprint workers link both ads to one audio asset; every other sample ad has notes of its own.
 */
export const SHARED_JINGLE_NOTES: readonly number[] = [523.25, 659.25, 783.99, 659.25, 880.0, 783.99, 659.25, 523.25];

/** A note with a few harmonics, a quick attack and a smooth fade, so it sounds like a note, not a click. */
function addNote(samples: Float64Array, frequency: number, startSeconds: number, lengthSeconds: number, loudness: number, harmonics: readonly number[]): void {
  const start = Math.floor(startSeconds * SAMPLE_RATE);
  const length = Math.floor(lengthSeconds * SAMPLE_RATE);
  for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
    const position = offset / length;
    const envelope = Math.min(position / 0.04, 1) * (1 - position) ** 0.8;
    let value = 0;
    harmonics.forEach((weight, index) => {
      value += weight * Math.sin((2 * Math.PI * frequency * (index + 1) * offset) / SAMPLE_RATE);
    });
    samples[start + offset] = (samples[start + offset] as number) + value * envelope * loudness;
  }
}

/** The same "random" numbers for the same notes: a small linear congruential generator seeded from them. */
function noiseFor(notes: readonly number[]): () => number {
  let state = Math.round(notes.reduce((sum, note) => sum + note * 100, 0)) >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

/** A jingle with the given notes (by default the shared one). Other notes make another recording. */
export function createSampleJingleWav(notes: readonly number[] = SHARED_JINGLE_NOTES): Buffer {
  const samples = new Float64Array(SAMPLE_RATE * SECONDS);
  const firstNote = notes[0] as number;
  // About 120 beats a minute, four to a bar: from 0.455 to 0.545 seconds a beat, depending on the notes.
  const beatSeconds = 0.5 * (0.91 + (Math.round(notes.reduce((sum, note) => sum + note, 0)) % 7) * 0.03);
  const beats = SECONDS / beatSeconds;

  // Melody: the notes in turn, on a repeating rhythm.
  for (let beat = 0, step = 0; beat < beats; step += 1) {
    const lengthBeats = MELODY_RHYTHM_BEATS[step % MELODY_RHYTHM_BEATS.length] as number;
    addNote(samples, notes[step % notes.length] as number, beat * beatSeconds, lengthBeats * beatSeconds * 0.95, 0.45, [1, 0.35, 0.15]);
    beat += lengthBeats;
  }
  // Chords: a major triad an octave below one of the notes, held for each bar of four beats.
  for (let bar = 0; bar < beats / 4; bar += 1) {
    const root = (notes[(bar * 3) % notes.length] as number) / 2;
    for (const ratio of [1, 1.26, 1.498]) addNote(samples, root * ratio, bar * 4 * beatSeconds, 4 * beatSeconds, 0.16, [1, 0.25]);
  }
  // Beat: a falling kick on beats one and three, a short noise snare on two and four, a tick on every half beat.
  const noise = noiseFor(notes);
  for (let halfBeat = 0; halfBeat < beats * 2; halfBeat += 1) {
    const start = Math.floor(halfBeat * (beatSeconds / 2) * SAMPLE_RATE);
    const isOnBeat = halfBeat % 2 === 0;
    const beatInBar = Math.floor(halfBeat / 2) % 4;
    const length = Math.floor((isOnBeat && beatInBar % 2 === 0 ? 0.14 : isOnBeat ? 0.1 : 0.03) * SAMPLE_RATE);
    let phase = 0;
    for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
      const decay = (1 - offset / length) ** 2;
      let value: number;
      if (isOnBeat && beatInBar % 2 === 0) {
        phase += (2 * Math.PI * (firstNote / 10 + 95 * (1 - offset / length))) / SAMPLE_RATE;
        value = Math.sin(phase) * 0.7;
      } else {
        value = noise() * (isOnBeat ? 0.35 : 0.12);
      }
      samples[start + offset] = (samples[start + offset] as number) + value * decay;
    }
  }

  const peak = samples.reduce((highest, value) => Math.max(highest, Math.abs(value)), 0) || 1;
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => pcm.writeInt16LE(Math.round((value / peak) * 0.85 * 32_767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // size of the format part
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
