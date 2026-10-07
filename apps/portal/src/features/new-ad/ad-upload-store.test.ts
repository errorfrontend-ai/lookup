import type { AdDetail, UploadInstructions } from '@lookup/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adDetail } from '../../test/ad-fixtures';
import { errorResponse, installFakeApi, jsonResponse } from '../../test/fake-api';
import { stationQueryKeys } from '../stations/station-query-keys';
import { cancelUpload, clearAllUploads, getUploadState, isAnyUploadRunning, replaceStorageTransport, retryUpload, startUpload, uploadAnotherFile } from './ad-upload-store';
import { StorageNetworkError, type StorageTransport, StorageUploadCancelled } from './send-file-to-storage';

const stationId = '0190f1a2-0000-7000-8000-000000000100';
const adId = '0190f1a2-0000-7000-8000-00000000ad01';
const file = new File([new Uint8Array(2_000)], 'summer_offer.mp3', { type: 'audio/mpeg' });

function instructions(overrides: Partial<UploadInstructions> = {}): UploadInstructions {
  return {
    method: 'PUT',
    url: 'https://storage.test/first-address',
    headers: { 'Content-Type': 'audio/mpeg' },
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const checkedAd: AdDetail = adDetail({ id: adId, status: 'PROCESSING' });
const completePath = `POST /stations/${stationId}/ads/${adId}/complete`;
const newAddressPath = `POST /stations/${stationId}/ads/${adId}/upload-url`;

let restoreTransport: () => void = () => undefined;

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
});

afterEach(() => {
  restoreTransport();
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function useTransport(transport: StorageTransport) {
  const fake = vi.fn(transport);
  restoreTransport = replaceStorageTransport(fake);
  return fake;
}

async function untilPhase(phase: 'uploading' | 'checking' | 'checked' | 'failed') {
  await vi.waitFor(() => expect(getUploadState(adId)?.phase).toBe(phase));
}

describe('the upload store', () => {
  it('sends the file to the signed address with exactly the signed type, then asks the API to check it', async () => {
    const percentsSeen: number[] = [];
    let stateAtStart: ReturnType<typeof getUploadState>;
    let wasRunningAtStart = false;
    const transport = useTransport(async ({ onProgress }) => {
      stateAtStart = { ...(getUploadState(adId) as NonNullable<ReturnType<typeof getUploadState>>) };
      wasRunningAtStart = isAnyUploadRunning();
      onProgress(0.4);
      percentsSeen.push(getUploadState(adId)?.percent ?? -1);
      onProgress(1);
      percentsSeen.push(getUploadState(adId)?.percent ?? -1);
      return { status: 200 };
    });
    const { calls } = installFakeApi({ [completePath]: () => jsonResponse(200, checkedAd), [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, {}) });

    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('checked');

    expect(stateAtStart).toMatchObject({ phase: 'uploading', percent: 0, file });
    expect(wasRunningAtStart).toBe(true);

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://storage.test/first-address', file, contentType: 'audio/mpeg' }));
    // Progress never reads 100 until the API has checked the file.
    expect(percentsSeen).toEqual([40, 99]);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
    expect(isAnyUploadRunning()).toBe(false);
    // The ad's own page learns the checked version without asking again.
    expect(queryClient.getQueryData(stationQueryKeys.adDetail(stationId, adId))).toEqual(checkedAd);
  });

  it('says the link expired when storage refuses with a 403 after the signed address ran out', async () => {
    useTransport(async () => ({ status: 403 }));
    installFakeApi({});
    startUpload({ stationId, adId, file, instructions: instructions({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) });
    await untilPhase('failed');
    expect(getUploadState(adId)?.failure).toBe('link_expired');
  });

  it('says storage refused when a 403 comes before the address expired', async () => {
    useTransport(async () => ({ status: 403 }));
    installFakeApi({});
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    expect(getUploadState(adId)?.failure).toBe('storage_refused');
  });

  it('keeps the file when the connection drops, and does not ask the API to check anything', async () => {
    useTransport(async () => {
      throw new StorageNetworkError();
    });
    const { calls } = installFakeApi({});
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    expect(getUploadState(adId)).toMatchObject({ failure: 'network', file });
    expect(calls).toHaveLength(0);
  });

  it('tries again with a fresh signed address and the same file, then completes', async () => {
    let attempt = 0;
    const transport = useTransport(async () => {
      attempt += 1;
      if (attempt === 1) throw new StorageNetworkError();
      return { status: 200 };
    });
    const { calls } = installFakeApi({
      [newAddressPath]: () => jsonResponse(200, instructions({ url: 'https://storage.test/second-address' })),
      [completePath]: () => jsonResponse(200, checkedAd),
    });

    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    await retryUpload(adId);
    await untilPhase('checked');

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0]).toMatchObject({ url: 'https://storage.test/second-address', file });
    expect(calls.find((call) => call.path.endsWith('/upload-url'))?.body).toEqual({ upload: { fileName: 'summer_offer.mp3', contentType: 'audio/mpeg', sizeBytes: 2_000 } });
    expect(getUploadState(adId)).toMatchObject({ failure: null, apiError: null });
  });

  it('says the upload could not start when a fresh address cannot be had, with the reference to quote', async () => {
    useTransport(async () => {
      throw new StorageNetworkError();
    });
    installFakeApi({ [newAddressPath]: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'ref12345') });
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    await retryUpload(adId);
    expect(getUploadState(adId)).toMatchObject({ phase: 'failed', failure: 'link_failed' });
    expect(getUploadState(adId)?.apiError?.requestId).toBe('ref12345');
  });

  it('tells a refused file from a file that never arrived from a check that could not be made', async () => {
    useTransport(async () => ({ status: 200 }));
    const completeWith = (status: number, code: string) => installFakeApi({ [completePath]: () => errorResponse(status, code, 'Words from the API.'), [`GET /stations/${stationId}/ads/${adId}`]: () => jsonResponse(200, checkedAd) });

    completeWith(422, 'UPLOAD_REJECTED');
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    expect(getUploadState(adId)?.failure).toBe('refused');

    completeWith(409, 'UPLOAD_NOT_RECEIVED');
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    expect(getUploadState(adId)?.failure).toBe('not_received');

    completeWith(500, 'INTERNAL');
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('failed');
    expect(getUploadState(adId)?.failure).toBe('check_failed');
  });

  it('stops an upload that is going up and keeps the file so it can be tried again', async () => {
    useTransport(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new StorageUploadCancelled()))));
    installFakeApi({});
    startUpload({ stationId, adId, file, instructions: instructions() });
    cancelUpload(adId);
    await untilPhase('failed');
    expect(getUploadState(adId)).toMatchObject({ failure: 'cancelled', file });
    expect(isAnyUploadRunning()).toBe(false);
  });

  it('replaces the file with another one: a fresh address, then the new file', async () => {
    const transport = useTransport(async () => ({ status: 200 }));
    installFakeApi({
      [newAddressPath]: () => jsonResponse(200, instructions({ url: 'https://storage.test/other-address', headers: { 'Content-Type': 'audio/wav' } })),
      [completePath]: () => jsonResponse(200, checkedAd),
    });
    const otherFile = new File([new Uint8Array(500)], 'second.wav', { type: 'audio/wav' });

    await uploadAnotherFile(stationId, adId, otherFile, 'audio/wav');
    await untilPhase('checked');

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://storage.test/other-address', file: otherFile, contentType: 'audio/wav' }));
    expect(getUploadState(adId)?.file).toBe(otherFile);
  });

  it('keeps the waveform read from the file, so the player looks the same after the ad is created', async () => {
    useTransport(async () => ({ status: 200 }));
    installFakeApi({ [completePath]: () => jsonResponse(200, checkedAd) });
    startUpload({ stationId, adId, file, peaks: [0.2, 1, 0.5], instructions: instructions() });
    await untilPhase('checked');
    expect(getUploadState(adId)?.peaks).toEqual([0.2, 1, 0.5]);
  });

  it('keeps each ad\'s upload apart', async () => {
    useTransport(async () => ({ status: 200 }));
    installFakeApi({ [completePath]: () => jsonResponse(200, checkedAd) });
    startUpload({ stationId, adId, file, instructions: instructions() });
    await untilPhase('checked');
    expect(getUploadState('0190f1a2-0000-7000-8000-00000000ad02')).toBeUndefined();
  });
});
