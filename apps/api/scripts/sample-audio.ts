/**
 * A short, pleasant jingle as a valid WAV file (8 kHz, 16-bit, mono), made in code so the development
 * sample ads have real audio to play in the portal without downloading or storing a recording.
 */
const SAMPLE_RATE = 8_000;
const SECONDS = 6;

/** The notes of the jingle, in hertz, each held for the same time. */
const NOTES = [523.25, 659.25, 783.99, 659.25, 880.0, 783.99, 659.25, 523.25];

export function createSampleJingleWav(): Buffer {
  const sampleCount = SAMPLE_RATE * SECONDS;
  const samplesPerNote = Math.floor(sampleCount / NOTES.length);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const noteIndex = Math.min(Math.floor(index / samplesPerNote), NOTES.length - 1);
    const positionInNote = (index % samplesPerNote) / samplesPerNote;
    // A quick attack and a smooth fade so each note sounds like a note, not a click.
    const envelope = Math.min(positionInNote / 0.05, 1) * (1 - positionInNote) ** 0.6;
    const frequency = NOTES[noteIndex] as number;
    const value = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * 0.55 + Math.sin((2 * Math.PI * frequency * 2 * index) / SAMPLE_RATE) * 0.15;
    pcm.writeInt16LE(Math.round(value * envelope * 0.7 * 32_767), index * 2);
  }
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
