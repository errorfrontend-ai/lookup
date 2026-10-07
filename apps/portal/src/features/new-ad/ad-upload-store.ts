import type { AdDetail, UploadInstructions, UploadRequest } from '@lookup/contracts';
import { useSyncExternalStore } from 'react';
import { ApiError } from '../../api/api-client';
import { portalApi, queryClient } from '../../app/portal-api';
import { stationQueryKeys } from '../stations/station-query-keys';
import { refreshAfterAdChange } from '../ads/use-ad-detail';
import { type StorageTransport, StorageUploadCancelled, sendFileToStorage } from './send-file-to-storage';

export type UploadPhase = 'uploading' | 'checking' | 'checked' | 'failed';

/** Why an upload did not finish, in the kinds the screen has words for. */
export type UploadFailure =
  | 'network' //        the connection dropped
  | 'link_expired' //   the signed address ran out before the file finished
  | 'storage_refused' // storage said no for another reason
  | 'link_failed' //    a fresh signed address could not be had (the file was not sent)
  | 'not_received' //   the file never arrived (the API could not find it)
  | 'refused' //        the API checked the file and refused it (not audio, wrong size)
  | 'check_failed' //   the check itself failed (server trouble)
  | 'cancelled'; //     the person stopped it

export interface UploadState {
  stationId: string;
  adId: string;
  file: File;
  /** The waveform read from the file in the browser, so the player looks the same after the ad is created. */
  peaks: number[] | null;
  contentType: UploadInstructions['headers']['Content-Type'];
  phase: UploadPhase;
  /** 0 to 100. */
  percent: number;
  failure: UploadFailure | null;
  /** For a failed check: the API's own message and its reference, so the screen can show them. */
  apiError: ApiError | null;
}

let transport: StorageTransport = sendFileToStorage;
const uploads = new Map<string, UploadState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

/** For tests: replace how bytes reach storage. Returns a function that puts the real one back. */
export function replaceStorageTransport(replacement: StorageTransport): () => void {
  transport = replacement;
  return () => {
    transport = sendFileToStorage;
  };
}

/** For tests: forget every upload. */
export function clearAllUploads(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  uploads.clear();
  notify();
}

function notify(): void {
  // Each state is replaced, never changed in place, so React sees the difference.
  for (const listener of listeners) listener();
}

function update(adId: string, changes: Partial<UploadState>): void {
  const current = uploads.get(adId);
  if (!current) return;
  uploads.set(adId, { ...current, ...changes });
  notify();
}

export function getUploadState(adId: string): UploadState | undefined {
  return uploads.get(adId);
}

/** The state of one ad's upload, and an update whenever it changes. Undefined when this page never started one. */
export function useUploadState(adId: string | undefined): UploadState | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (adId ? uploads.get(adId) : undefined),
    () => undefined,
  );
}

/** Whether any upload is still going up or being checked: the page warns before it is closed. */
export function isAnyUploadRunning(): boolean {
  return [...uploads.values()].some((upload) => upload.phase === 'uploading' || upload.phase === 'checking');
}

/**
 * Sends the file to storage with the address the API signed, then asks the API to check it. It carries
 * on if the person moves to another page of the portal. A failure is kept with the file, so "Try again"
 * needs no second choosing of the file.
 */
export function startUpload(request: { stationId: string; adId: string; file: File; peaks?: number[] | null; instructions: UploadInstructions }): void {
  uploads.set(request.adId, {
    stationId: request.stationId,
    adId: request.adId,
    file: request.file,
    peaks: request.peaks ?? null,
    contentType: request.instructions.headers['Content-Type'],
    phase: 'uploading',
    percent: 0,
    failure: null,
    apiError: null,
  });
  notify();
  void run(request.adId, request.instructions);
}

async function run(adId: string, instructions: UploadInstructions): Promise<void> {
  const state = uploads.get(adId);
  if (!state) return;
  controllers.get(adId)?.abort();
  const controller = new AbortController();
  controllers.set(adId, controller);

  try {
    const { status } = await transport({
      url: instructions.url,
      file: state.file,
      contentType: instructions.headers['Content-Type'],
      onProgress: (fraction) => update(adId, { percent: Math.min(99, Math.round(fraction * 100)) }),
      signal: controller.signal,
    });
    if (status < 200 || status >= 300) {
      const hasExpired = status === 403 && Date.now() > new Date(instructions.expiresAt).getTime();
      update(adId, { phase: 'failed', failure: hasExpired ? 'link_expired' : 'storage_refused' });
      return;
    }
  } catch (error) {
    if (error instanceof StorageUploadCancelled) update(adId, { phase: 'failed', failure: 'cancelled' });
    else update(adId, { phase: 'failed', failure: 'network' });
    return;
  }

  await checkUpload(adId);
}

/** Asks the API to check the file that is in storage. Asking again is safe: an ad already checked just comes back as it is. */
async function checkUpload(adId: string): Promise<void> {
  const state = uploads.get(adId);
  if (!state) return;
  update(adId, { phase: 'checking', percent: 100, failure: null, apiError: null });
  try {
    const checked = await portalApi.post<AdDetail>(`/stations/${state.stationId}/ads/${adId}/complete`);
    update(adId, { phase: 'checked' });
    refreshAfterAdChange(queryClient, state.stationId, adId, checked);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : null;
    const failure: UploadFailure = apiError?.code === 'UPLOAD_NOT_RECEIVED' ? 'not_received' : apiError?.code === 'UPLOAD_REJECTED' ? 'refused' : 'check_failed';
    update(adId, { phase: 'failed', failure, apiError });
    // The API has recorded why a refused file was refused; the ad's page shows it once it is read again.
    if (failure === 'refused') void queryClient.invalidateQueries({ queryKey: stationQueryKeys.adDetail(state.stationId, adId) });
  }
}

/** Stops an upload that is still going up. It stays in the store as cancelled, so the file can be tried again. */
export function cancelUpload(adId: string): void {
  controllers.get(adId)?.abort();
}

/**
 * Tries again with the same file. When the file reached storage and only the check failed, just the
 * check is asked for again (sending it again would waste the station's data). Otherwise a fresh signed
 * address is asked for (the old one is used up or expired), then the file goes up and is checked.
 */
export async function retryUpload(adId: string): Promise<void> {
  const state = uploads.get(adId);
  if (!state) return;
  if (state.failure === 'check_failed') await checkUpload(adId);
  else await sendAgain(adId, state.file);
}

/** Replaces the file (after a refusal, or when the page was reloaded and the file is gone): a fresh address, then the new file. */
export async function uploadAnotherFile(stationId: string, adId: string, file: File, contentType: UploadRequest['contentType'], peaks: number[] | null = null): Promise<void> {
  uploads.set(adId, { stationId, adId, file, peaks, contentType, phase: 'uploading', percent: 0, failure: null, apiError: null });
  notify();
  await sendAgain(adId, file);
}

async function sendAgain(adId: string, file: File): Promise<void> {
  const state = uploads.get(adId);
  if (!state) return;
  update(adId, { phase: 'uploading', percent: 0, failure: null, apiError: null });
  try {
    const instructions = await portalApi.post<UploadInstructions>(`/stations/${state.stationId}/ads/${adId}/upload-url`, {
      upload: { fileName: file.name, contentType: state.contentType, sizeBytes: file.size },
    });
    // A fresh address puts a refused ad back to waiting for its audio; the ad's page reads that again.
    void queryClient.invalidateQueries({ queryKey: stationQueryKeys.adDetail(state.stationId, adId) });
    await run(adId, instructions);
  } catch (error) {
    update(adId, { phase: 'failed', failure: 'link_failed', apiError: error instanceof ApiError ? error : null });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!isAnyUploadRunning()) return;
    event.preventDefault();
  });
}
