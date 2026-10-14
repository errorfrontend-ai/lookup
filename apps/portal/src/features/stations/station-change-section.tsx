import type { RequestStationDetailChangeInput, StationChangeRequest, StationChangeRequestState, StationUploadAddress } from '@lookup/contracts';
import { contentTypeForStationFile, MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextField } from '../../components/text-field';
import { sendFileToStorage } from '../new-ad/send-file-to-storage';
import { tidyFrequencyLabel } from './parse-frequency-label';
import { FileUploadField } from '../../components/file-upload-field';
import { fieldErrorsFrom } from '../../plain-words/sign-up-words';
import type { StationFileUploadState } from '../../components/file-upload-field';
import type { NamedMemberStation } from './use-current-station';

/** What a change asks for, in a line: "name to Renamed FM, a new licence document". */
export function changeSummary(approved: StationChangeRequestState['approved'], request: StationChangeRequest): string {
  const parts = [
    request.name !== approved.name ? `name to ${request.name}` : null,
    request.frequencyLabel !== approved.frequencyLabel ? `frequency to ${request.frequencyLabel}` : null,
    request.licenceNumber !== approved.licenceNumber ? `licence number to ${request.licenceNumber}` : null,
    request.hasNewLicenceDocument ? 'a new licence document' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no visible change';
}

/**
 * "Name, frequency and licence" on the station profile (O2 as the user chose, P5A-D4; P5A design §4.5): the approved
 * values, and for an owner of an approved station "Ask to change these". While a change waits it says so, with
 * "Withdraw"; a refused one shows the reviewer's words.
 */
export function StationChangeSection({ station }: { station: NamedMemberStation }) {
  const queryClient = useQueryClient();
  const queryKey = ['stations', station.id, 'change-request'] as const;
  const state = useQuery({ queryKey, queryFn: () => portalApi.get<StationChangeRequestState>(`/stations/${station.id}/change-request`) });
  const [isAsking, setIsAsking] = useState(false);
  const withdraw = useMutation({
    mutationFn: () => portalApi.post<StationChangeRequestState>(`/stations/${station.id}/change-request/withdrawal`),
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });
  const canAsk = station.role === 'OWNER' && station.status === 'ACTIVE';

  if (state.isPending) return null;
  if (state.isError) return <ErrorNotice error={state.error} title="We couldn't load the name, frequency and licence" />;
  const { approved, open, lastDecided } = state.data;

  return (
    <section aria-labelledby="station-change-heading" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <h2 id="station-change-heading" className="text-title">
        Name, frequency and licence
      </h2>
      <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Name</dt>
        <dd>{approved.name}</dd>
        <dt className="text-muted">Frequency</dt>
        <dd>{approved.frequencyLabel}</dd>
        <dt className="text-muted">Licence number</dt>
        <dd>{approved.licenceNumber ?? 'Not given'}</dd>
      </dl>
      {open ? (
        <div role="status" className="flex flex-col items-start gap-2 rounded-md bg-warning-soft px-4 py-3">
          <p className="text-body">Waiting for review: {changeSummary(approved, open)}.</p>
          {station.role === 'OWNER' ? (
            <Button variant="secondary" onClick={() => withdraw.mutate()} isBusy={withdraw.isPending} busyLabel="Withdrawing…">
              Withdraw
            </Button>
          ) : null}
          {withdraw.isError ? <ErrorNotice error={withdraw.error} /> : null}
        </div>
      ) : lastDecided?.decision === 'REJECTED' ? (
        <p className="rounded-md bg-danger-soft px-4 py-3 text-body">Not approved: {lastDecided.decisionNote}</p>
      ) : null}
      {canAsk && !open && !isAsking ? (
        <Button variant="secondary" className="self-start" onClick={() => setIsAsking(true)}>
          Ask to change these
        </Button>
      ) : null}
      {canAsk && !open && isAsking ? (
        <ChangeForm
          stationId={station.id}
          approved={approved}
          onDone={(saved) => {
            queryClient.setQueryData(queryKey, saved);
            setIsAsking(false);
          }}
          onCancel={() => setIsAsking(false)}
        />
      ) : null}
      {!canAsk ? <p className="text-caption text-muted">Changes to these are checked by Look Up before they show. Only an owner can ask for one.</p> : null}
    </section>
  );
}

function ChangeForm({
  stationId,
  approved,
  onDone,
  onCancel,
}: {
  stationId: string;
  approved: StationChangeRequestState['approved'];
  onDone: (saved: StationChangeRequestState) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(approved.name);
  const [frequencyLabel, setFrequencyLabel] = useState(approved.frequencyLabel);
  const [licenceNumber, setLicenceNumber] = useState(approved.licenceNumber ?? '');
  const [documentUploadId, setDocumentUploadId] = useState<string | null>(null);
  const [upload, setUpload] = useState<StationFileUploadState>({ stage: 'idle' });
  const lastFile = useRef<File | null>(null);
  const request = useMutation({
    mutationFn: (input: RequestStationDetailChangeInput) => portalApi.post<StationChangeRequestState>(`/stations/${stationId}/change-requests`, input),
    onSuccess: onDone,
  });
  const fieldErrors = fieldErrorsFrom(request.error);
  const isNothingChanged = request.error instanceof ApiError && request.error.fields.some((field) => field.code === 'nothing_changed');

  const sendDocument = async (file: File) => {
    lastFile.current = file;
    const contentType = contentTypeForStationFile(file, 'licence-document');
    if (!contentType) return setUpload({ stage: 'failed', fileName: file.name, reason: 'wrong_file_type' });
    if (file.size > MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES) return setUpload({ stage: 'failed', fileName: file.name, reason: 'file_too_large' });
    setUpload({ stage: 'uploading', fileName: file.name, percent: 0 });
    try {
      const address = await portalApi.post<StationUploadAddress>(`/stations/${stationId}/change-request/licence-document-uploads`, {
        fileName: file.name.slice(0, 120),
        contentType,
        byteCount: file.size,
      });
      const sent = await sendFileToStorage({
        url: address.uploadUrl,
        file,
        contentType,
        onProgress: (fraction) => setUpload({ stage: 'uploading', fileName: file.name, percent: Math.round(fraction * 100) }),
        signal: new AbortController().signal,
      });
      if (sent.status < 200 || sent.status >= 300) return setUpload({ stage: 'failed', fileName: file.name, reason: 'upload_not_received' });
      await portalApi.post<void>(`/stations/${stationId}/change-request/licence-document-uploads/${address.uploadId}/complete`);
      setDocumentUploadId(address.uploadId);
      return setUpload({ stage: 'done', fileName: file.name });
    } catch (problem) {
      return setUpload({ stage: 'failed', fileName: file.name, reason: problem instanceof ApiError ? (problem.fields[0]?.code ?? problem.code) : 'network' });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    request.mutate({ name: name.trim(), frequencyLabel: tidyFrequencyLabel(frequencyLabel), licenceNumber: licenceNumber.trim(), licenceDocumentUploadId: documentUploadId });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="rounded-md bg-warning-soft px-4 py-3 text-body">We check these changes before they show. Until then your station keeps its current name and frequency.</p>
      <TextField label="Station name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} error={fieldErrors.name && !isNothingChanged ? fieldErrors.name : null} />
      <TextField label="Frequency" maxLength={32} value={frequencyLabel} onChange={(event) => setFrequencyLabel(event.target.value)} error={fieldErrors.frequencyLabel} />
      <TextField label="Licence number" maxLength={60} value={licenceNumber} onChange={(event) => setLicenceNumber(event.target.value)} error={fieldErrors.licenceNumber} />
      <FileUploadField
        label="New licence document (optional)"
        hint="PDF or a clear photo, up to 5 MB. Only our review team can see it."
        accept="application/pdf,image/jpeg"
        savedFileName={null}
        state={upload}
        onChoose={(file) => void sendDocument(file)}
        onTryAgain={() => void (lastFile.current && sendDocument(lastFile.current))}
      />
      {isNothingChanged ? <p role="alert" className="text-body font-bold text-danger">Change at least one thing first.</p> : null}
      {request.isError && !isNothingChanged && Object.keys(fieldErrors).length === 0 ? <ErrorNotice error={request.error} /> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!name.trim() || !frequencyLabel.trim() || !licenceNumber.trim() || upload.stage === 'uploading'} isBusy={request.isPending} busyLabel="Sending…">
          Send for review
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
