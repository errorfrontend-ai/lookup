import { useId, useRef } from 'react';
import { Button } from '../../components/button';
import { ProgressBar } from '../../components/progress-bar';
import { fieldReasonWords } from '../../plain-words/sign-up-words';
import type { StationFileUploadState } from './use-station-application';

/** Why an upload failed, in plain words ("network" is the connection's fault). */
export function uploadFailureWords(reason: string): string {
  return reason === 'network' ? "The upload didn't finish. Check your connection, then try again." : fieldReasonWords(reason, "We couldn't use this file. Try another one.");
}

/**
 * A file chosen and sent with its progress (P5A design §4.2): its name, "Uploading 40 %", "Uploaded" or "Upload
 * failed" with the reason, and a button to choose (or replace) the file.
 */
export function FileUploadField({
  label,
  hint,
  accept,
  savedFileName,
  state,
  onChoose,
}: {
  label: string;
  hint: string;
  accept: string;
  /** The file already saved with the application, if any. */
  savedFileName: string | null;
  state: StationFileUploadState;
  onChoose: (file: File) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const shownName = state.stage === 'idle' ? savedFileName : state.fileName;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-label">
        {label}
      </label>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={accept}
        aria-describedby={`${inputId}-hint`}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          event.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={state.stage === 'uploading'}>
          {shownName ? 'Replace' : 'Choose a file'}
        </Button>
        {shownName ? <span className="min-w-0 truncate text-body">{shownName}</span> : null}
        {state.stage === 'done' || (state.stage === 'idle' && savedFileName) ? <span className="text-label text-success">Uploaded</span> : null}
      </div>
      {state.stage === 'uploading' ? (
        <div className="flex flex-col gap-1">
          <span aria-live="polite" className="text-caption text-muted">
            Uploading {state.percent} %
          </span>
          <ProgressBar percent={state.percent} label={`Uploading ${shownName ?? 'the file'}`} />
        </div>
      ) : null}
      {state.stage === 'failed' ? (
        <span role="alert" className="text-caption font-bold text-danger">
          Upload failed. {uploadFailureWords(state.reason)}
        </span>
      ) : null}
      <span id={`${inputId}-hint`} className="text-caption text-muted">
        {hint}
      </span>
    </div>
  );
}
