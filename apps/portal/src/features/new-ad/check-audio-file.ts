import {
  type AdUploadContentType,
  canonicalAdContentType,
  MAXIMUM_AD_DURATION_SECONDS,
  MAXIMUM_AD_UPLOAD_SIZE_BYTES,
  MINIMUM_AD_DURATION_SECONDS,
} from '@lookup/contracts';
import { formatFileSize } from '../../formatting/format-file-size';

/** The number of bars drawn for a file's own waveform. */
export const WAVEFORM_BAR_COUNT = 48;
const DECODE_TIMEOUT_MILLISECONDS = 5_000;

export interface AudioFileFacts {
  /** How long the audio plays, or null when the browser could not tell. */
  durationSeconds: number | null;
  /** Bar heights from 0 to 1 drawn from the audio itself, or null when the browser could not decode it. */
  peaks: number[] | null;
}

export type AudioFileCheck =
  | { isAcceptable: true; contentType: AdUploadContentType; facts: AudioFileFacts }
  | { isAcceptable: false; problem: string };

/**
 * Reads the audio in the browser: how long it is, and its waveform. It is only a courtesy to catch a
 * wrong file early (the server decides what is accepted), so a browser that can't decode the file just
 * returns nothing, and the file goes up anyway.
 */
export async function readAudioFileFacts(file: Blob): Promise<AudioFileFacts> {
  const AudioContextConstructor: typeof AudioContext | undefined =
    typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioContextConstructor) return { durationSeconds: null, peaks: null };
  const context = new AudioContextConstructor();
  try {
    const decoded = await Promise.race([
      context.decodeAudioData(await file.arrayBuffer()),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DECODE_TIMEOUT_MILLISECONDS)),
    ]);
    if (!decoded) return { durationSeconds: null, peaks: null };
    const samples = decoded.getChannelData(0);
    const samplesPerBar = Math.max(1, Math.floor(samples.length / WAVEFORM_BAR_COUNT));
    const rawPeaks = Array.from({ length: WAVEFORM_BAR_COUNT }, (_unused, bar) => {
      let highest = 0;
      for (let index = bar * samplesPerBar; index < Math.min(samples.length, (bar + 1) * samplesPerBar); index += 1) highest = Math.max(highest, Math.abs(samples[index] as number));
      return highest;
    });
    const loudest = Math.max(...rawPeaks, 0.0001);
    return { durationSeconds: decoded.duration, peaks: rawPeaks.map((peak) => Math.max(0.12, peak / loudest)) };
  } catch {
    return { durationSeconds: null, peaks: null };
  } finally {
    void context.close().catch(() => undefined);
  }
}

/**
 * Whether a chosen file can be uploaded, in words for the person if not: a supported type, within the
 * size limit, and (when the browser can tell) between 5 seconds and 2 minutes long.
 */
export async function checkAudioFile(file: File, readFacts: (file: Blob) => Promise<AudioFileFacts> = readAudioFileFacts): Promise<AudioFileCheck> {
  const contentType = canonicalAdContentType(file.name, file.type);
  if (!contentType) return { isAcceptable: false, problem: 'Choose an MP3, WAV or M4A audio file.' };
  if (file.size === 0) return { isAcceptable: false, problem: 'This file is empty. Choose a different one.' };
  if (file.size > MAXIMUM_AD_UPLOAD_SIZE_BYTES) {
    return { isAcceptable: false, problem: `This file is ${formatFileSize(file.size)}. The limit is ${formatFileSize(MAXIMUM_AD_UPLOAD_SIZE_BYTES)}.` };
  }
  const facts = await readFacts(file);
  if (facts.durationSeconds !== null) {
    const seconds = Math.round(facts.durationSeconds);
    if (facts.durationSeconds < MINIMUM_AD_DURATION_SECONDS) {
      return { isAcceptable: false, problem: `This ad is ${seconds} second${seconds === 1 ? '' : 's'} long. Ads must be at least ${MINIMUM_AD_DURATION_SECONDS} seconds.` };
    }
    if (facts.durationSeconds > MAXIMUM_AD_DURATION_SECONDS) {
      return { isAcceptable: false, problem: `This ad is ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} long. Ads can be at most ${MAXIMUM_AD_DURATION_SECONDS / 60} minutes.` };
    }
  }
  return { isAcceptable: true, contentType, facts };
}

/** A title to start from, made from the file's name: "summer_offer_final.mp3" becomes "Summer offer final". */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[A-Za-z0-9]+$/, '');
  const words = withoutExtension.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}
