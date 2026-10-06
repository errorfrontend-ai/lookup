import { MAXIMUM_AD_UPLOAD_SIZE_BYTES } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { checkAudioFile, titleFromFileName } from './check-audio-file';

function fileOf(name: string, type: string, sizeBytes = 1_000): File {
  return new File([new Uint8Array(Math.min(sizeBytes, 1_000))], name, { type });
}

/** A file that claims to be larger than it is, so the size rule can be tried without building 20 MB. */
function fileClaimingSize(name: string, type: string, sizeBytes: number): File {
  const file = fileOf(name, type);
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

const lastingSeconds = (durationSeconds: number | null) => async () => ({ durationSeconds, peaks: null });

describe('checking a chosen audio file', () => {
  it('accepts an MP3, WAV or M4A of a fair length and says which type to sign the upload for', async () => {
    const mp3 = await checkAudioFile(fileOf('offer.mp3', 'audio/mpeg'), lastingSeconds(30));
    const wav = await checkAudioFile(fileOf('offer.wav', 'audio/wav'), lastingSeconds(30));
    const m4a = await checkAudioFile(fileOf('offer.m4a', 'audio/x-m4a'), lastingSeconds(30));
    expect(mp3).toMatchObject({ isAcceptable: true, contentType: 'audio/mpeg' });
    expect(wav).toMatchObject({ isAcceptable: true, contentType: 'audio/wav' });
    expect(m4a).toMatchObject({ isAcceptable: true, contentType: 'audio/mp4' });
  });

  it('works out the type from the name when the browser reports none', async () => {
    const check = await checkAudioFile(fileOf('offer.mp3', ''), lastingSeconds(30));
    expect(check).toMatchObject({ isAcceptable: true, contentType: 'audio/mpeg' });
  });

  it('refuses a file that is not one of the three audio types', async () => {
    const check = await checkAudioFile(fileOf('notes.txt', 'text/plain'), lastingSeconds(30));
    expect(check).toEqual({ isAcceptable: false, problem: 'Choose an MP3, WAV or M4A audio file.' });
  });

  it('refuses an empty file', async () => {
    const check = await checkAudioFile(fileClaimingSize('offer.mp3', 'audio/mpeg', 0), lastingSeconds(30));
    expect(check).toMatchObject({ isAcceptable: false, problem: 'This file is empty. Choose a different one.' });
  });

  it('refuses a file over the size limit and says both sizes', async () => {
    const check = await checkAudioFile(fileClaimingSize('offer.mp3', 'audio/mpeg', MAXIMUM_AD_UPLOAD_SIZE_BYTES + 1), lastingSeconds(30));
    expect(check.isAcceptable).toBe(false);
    if (!check.isAcceptable) expect(check.problem).toMatch(/^This file is .*\. The limit is .*\.$/);
  });

  it('refuses audio shorter than 5 seconds or longer than 2 minutes, saying how long it is', async () => {
    const tooShort = await checkAudioFile(fileOf('offer.mp3', 'audio/mpeg'), lastingSeconds(3.2));
    const tooLong = await checkAudioFile(fileOf('offer.mp3', 'audio/mpeg'), lastingSeconds(125));
    expect(tooShort).toEqual({ isAcceptable: false, problem: 'This ad is 3 seconds long. Ads must be at least 5 seconds.' });
    expect(tooLong).toEqual({ isAcceptable: false, problem: 'This ad is 2:05 long. Ads can be at most 2 minutes.' });
  });

  it('lets a file through when the browser cannot tell its length (the server decides)', async () => {
    const check = await checkAudioFile(fileOf('offer.mp3', 'audio/mpeg'), lastingSeconds(null));
    expect(check).toMatchObject({ isAcceptable: true, facts: { durationSeconds: null, peaks: null } });
  });
});

describe('a starting title from the file name', () => {
  it.each([
    ['summer_offer_final.mp3', 'Summer offer final'],
    ['Brand-A.Jingle.wav', 'Brand A Jingle'],
    ['  spaced   out .m4a', 'Spaced out'],
    ['.mp3', ''],
  ])('%s becomes %j', (fileName, title) => {
    expect(titleFromFileName(fileName)).toBe(title);
  });
});
