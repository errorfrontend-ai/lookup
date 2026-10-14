import { contentTypeForStationFile, type StationApplication, type StationUploadAddress } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import type { StationFileUploadState } from '../../components/file-upload-field';
import { sendFileToStorage, type StorageTransport } from '../new-ad/send-file-to-storage';

export const stationApplicationQueryKey = (stationId: string) => ['station-application', stationId] as const;

const SECOND = 1000;

/**
 * How often step 2 asks whether the email is confirmed (P5A design §4.2, "this page updates by itself"): every 5 s for
 * 2 minutes, then every 15 s, stopping after 30 minutes (the page then offers "Check again"). False stops it.
 */
export function confirmationPollingInterval(millisecondsSinceStart: number): number | false {
  if (millisecondsSinceStart >= 30 * 60 * SECOND) return false;
  return millisecondsSinceStart < 2 * 60 * SECOND ? 5 * SECOND : 15 * SECOND;
}

/** The application as the server keeps it; `isPolling` asks again on the schedule above until it stops. */
export function useStationApplication(stationId: string, options: { isPolling?: boolean } = {}) {
  const [pollingStartedAt, setPollingStartedAt] = useState(() => Date.now());
  const query = useQuery({
    queryKey: stationApplicationQueryKey(stationId),
    queryFn: () => portalApi.get<StationApplication>(`/stations/${stationId}/application`),
    refetchInterval: options.isPolling ? () => confirmationPollingInterval(Date.now() - pollingStartedAt) : false,
    refetchOnWindowFocus: options.isPolling ? 'always' : false,
  });
  const isPollingStopped = Boolean(options.isPolling) && confirmationPollingInterval(Date.now() - pollingStartedAt) === false;
  const checkAgain = useCallback(() => {
    setPollingStartedAt(Date.now());
    void query.refetch();
  }, [query]);
  // A tab coming back into view asks at once (P5A design §4.2).
  useEffect(() => {
    if (!options.isPolling) return undefined;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void query.refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [options.isPolling, query]);
  return { ...query, isPollingStopped, checkAgain };
}

/** A change to the application whose answer is the application as saved; the cache takes it at once. */
export function useApplicationChange<Input>(stationId: string, send: (input: Input) => Promise<StationApplication | void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: async (saved) => {
      if (saved) queryClient.setQueryData(stationApplicationQueryKey(stationId), saved);
      else await queryClient.invalidateQueries({ queryKey: stationApplicationQueryKey(stationId) });
    },
  });
}

export type { StationFileUploadState } from '../../components/file-upload-field';

/** Largest sizes by purpose, checked before anything is sent (the API checks again). */
const LARGEST_BYTES = { logo: 2 * 1024 * 1024, 'licence-document': 5 * 1024 * 1024 } as const;

/**
 * A logo or licence document going up (P5A design §3.2): the API signs an address for the file's type and size, the
 * browser sends it straight to storage with progress, then the API checks what arrived and answers the application.
 * `reason` is a field reason code (see plain-words/sign-up-words.ts) or "network".
 */
export function useStationFileUpload(
  stationId: string,
  purpose: 'logo' | 'licence-document',
  transport: StorageTransport = sendFileToStorage,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StationFileUploadState>({ stage: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const lastFile = useRef<File | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const upload = useCallback(
    async (file: File) => {
      lastFile.current = file;
      const contentType = contentTypeForStationFile(file, purpose);
      if (!contentType) return setState({ stage: 'failed', fileName: file.name, reason: 'wrong_file_type' });
      if (file.size > LARGEST_BYTES[purpose]) return setState({ stage: 'failed', fileName: file.name, reason: 'file_too_large' });
      setState({ stage: 'uploading', fileName: file.name, percent: 0 });
      const path = purpose === 'logo' ? 'logo-uploads' : 'licence-document-uploads';
      abort.current = new AbortController();
      try {
        const address = await portalApi.post<StationUploadAddress>(`/stations/${stationId}/application/${path}`, {
          fileName: file.name.slice(0, 120),
          contentType,
          byteCount: file.size,
        });
        const sent = await transport({
          url: address.uploadUrl,
          file,
          contentType,
          onProgress: (fraction) => setState({ stage: 'uploading', fileName: file.name, percent: Math.round(fraction * 100) }),
          signal: abort.current.signal,
        });
        if (sent.status < 200 || sent.status >= 300) return setState({ stage: 'failed', fileName: file.name, reason: 'upload_not_received' });
        const saved = await portalApi.post<StationApplication>(`/stations/${stationId}/application/${path}/${address.uploadId}/complete`);
        queryClient.setQueryData(stationApplicationQueryKey(stationId), saved);
        return setState({ stage: 'done', fileName: file.name });
      } catch (problem) {
        const reason = problem instanceof ApiError ? (problem.fields[0]?.code ?? problem.code) : 'network';
        return setState({ stage: 'failed', fileName: file.name, reason });
      }
    },
    [purpose, queryClient, stationId, transport],
  );
  const tryAgain = useCallback(() => (lastFile.current ? upload(lastFile.current) : Promise.resolve()), [upload]);
  return { state, upload, tryAgain };
}
