import { type AdDetail, MAXIMUM_AD_TITLE_LENGTH } from '@lookup/contracts';
import { type DragEvent, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { Icon } from '../../components/icons';
import { TextField } from '../../components/text-field';
import { formatFileSize } from '../../formatting/format-file-size';
import { describeFileStatus } from '../../plain-words/ad-status-words';
import { describeUploadFailure, describeUploadRefusal } from '../../plain-words/upload-words';
import { cancelUpload, retryUpload, type UploadState, uploadAnotherFile } from './ad-upload-store';
import { checkAudioFile } from './check-audio-file';
import { LocalAudioPreview } from './local-audio-preview';
import type { ChosenAudio } from './use-chosen-audio';
import { UploadStages } from './upload-stages';
import { browserMaxLength } from '../../formatting/text-length';

const ACCEPTED_FILES = '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';
const FILE_RULES = 'MP3, WAV or M4A · up to 20 MB · between 5 seconds and 2 minutes long.';

/** A box to choose (or drop) an audio file into. The whole box is one control, so it works with a keyboard and a screen reader. */
function FileChooser({ onChoose, label }: { onChoose: (file: File) => void; label: string }) {
  const inputReference = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onChoose(file);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={drop}
      className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center ${isDragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}
    >
      <span className="flex size-12 items-center justify-center rounded-pill bg-accent-soft text-accent">
        <Icon name="upload" size={24} />
      </span>
      <Button variant="secondary" onClick={() => inputReference.current?.click()}>
        {label}
      </Button>
      <input
        ref={inputReference}
        type="file"
        accept={ACCEPTED_FILES}
        className="sr-only"
        tabIndex={-1}
        aria-label="Audio file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          event.target.value = '';
        }}
      />
      <p className="text-caption text-muted">or drop it here · {FILE_RULES}</p>
    </div>
  );
}

function FileCard({ name, detail, children }: { name: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon name="music" size={22} />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-label">{name}</span>
          <span className="text-caption text-muted">{detail}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const whole = Math.round(seconds);
  return ` · ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Step 2 before the ad exists: choose the file, check it, name the ad. Nothing is sent until "Upload ad". */
function ChooseAudio({ chosen, titleProblem }: { chosen: ChosenAudio; titleProblem: string | null }) {
  const { file, check, isChecking } = chosen;
  const facts = check?.isAcceptable ? check.facts : null;
  return (
    <div className="flex flex-col gap-5">
      {file ? (
        <FileCard name={file.name} detail={`${formatFileSize(file.size)}${formatDuration(facts?.durationSeconds ?? null)}`}>
          {check?.isAcceptable ? <LocalAudioPreview file={file} peaks={facts?.peaks ?? null} title={chosen.title} /> : null}
          {isChecking ? <p className="text-caption text-muted">Looking at the file…</p> : null}
          {check && !check.isAcceptable ? (
            <p role="alert" className="text-body font-bold text-danger">
              {check.problem}
            </p>
          ) : null}
          <Button variant="secondary" className="self-start" onClick={chosen.clear}>
            Choose a different file
          </Button>
        </FileCard>
      ) : (
        <FileChooser onChoose={(next) => void chosen.choose(next)} label="Choose an audio file" />
      )}

      {file && check?.isAcceptable ? (
        <TextField
          label="Ad title"
          hint="What you will see in your lists, and what listeners see above the buttons."
          value={chosen.title}
          onChange={(event) => chosen.setTitle(event.target.value)}
          maxLength={browserMaxLength(MAXIMUM_AD_TITLE_LENGTH)}
          counter={`${[...chosen.title].length} / ${MAXIMUM_AD_TITLE_LENGTH}`}
          error={titleProblem}
          autoComplete="off"
        />
      ) : null}
    </div>
  );
}

/** Step 2 once the ad exists: where the upload has got to, and what to do if it failed. */
function UploadProgress({ stationId, ad, upload }: { stationId: string; ad: AdDetail | undefined; upload: UploadState | undefined }) {
  const hasArrived = ad?.status === 'PROCESSING' || ad?.status === 'READY' || ad?.status === 'NEEDS_REVIEW';
  // Once the ad shows its audio checked, an earlier failure on this page is out of date: set it aside.
  const currentUpload = upload && !(hasArrived && upload.phase === 'failed') ? upload : undefined;
  // A new file going up (or already in) wins over an earlier refusal that the cached ad still shows.
  const showsRefusal = ad?.status === 'FAILED' && !currentUpload;
  const needsFile = Boolean(ad) && !hasArrived && !currentUpload && ad?.status !== 'FAILED';
  const fileName = currentUpload?.file.name ?? ad?.uploadedFileName ?? 'Your audio';
  const fileSize = currentUpload?.file.size ?? ad?.uploadSizeBytes ?? null;

  const [replacementProblem, setReplacementProblem] = useState<string | null>(null);

  const chooseReplacement = async (file: File) => {
    setReplacementProblem(null);
    const check = await checkAudioFile(file);
    if (!check.isAcceptable) {
      setReplacementProblem(check.problem);
      return;
    }
    if (ad) void uploadAnotherFile(stationId, ad.id, file, check.contentType, check.facts.peaks);
  };

  return (
    <div className="flex flex-col gap-4">
      {currentUpload || ad?.uploadedFileName ? (
        <FileCard name={fileName} detail={fileSize ? formatFileSize(fileSize) : ''}>
          {currentUpload && currentUpload.phase !== 'failed' ? <LocalAudioPreview file={currentUpload.file} peaks={currentUpload.peaks} title={ad?.title ?? ''} /> : null}
        </FileCard>
      ) : null}

      {currentUpload?.phase !== 'failed' && !showsRefusal && !needsFile ? (
        <section aria-label="Upload" className="rounded-lg border border-line-soft bg-surface p-4">
          <UploadStages ad={ad} upload={currentUpload} />
          {/* Only the sending can be stopped; the check that follows is the API's and takes a moment. */}
          {currentUpload?.phase === 'uploading' ? (
            <Button variant="quiet" className="mt-3" onClick={() => cancelUpload(currentUpload.adId)}>
              Stop upload
            </Button>
          ) : null}
        </section>
      ) : null}

      {currentUpload?.phase === 'failed' ? (
        <div className="flex flex-col gap-3 rounded-lg border border-danger bg-danger-soft p-4">
          <p role="alert" className="text-body font-bold text-danger">
            {currentUpload.failure === 'refused' && ad?.processingErrorCode ? describeUploadRefusal(ad.processingErrorCode) : describeUploadFailure(currentUpload.failure ?? 'storage_refused')}
          </p>
          {currentUpload.apiError ? <ErrorNotice error={currentUpload.apiError} /> : null}
          <div className="flex flex-wrap gap-2">
            {currentUpload.failure !== 'refused' ? <Button onClick={() => void retryUpload(currentUpload.adId)}>Try again</Button> : null}
            <FileReplacer onChoose={(file) => void chooseReplacement(file)} label="Choose a different file" />
          </div>
        </div>
      ) : null}

      {showsRefusal && ad ? (
        <div className="flex flex-col gap-3 rounded-lg border border-danger bg-danger-soft p-4">
          <p role="alert" className="text-body font-bold text-danger">
            {describeUploadRefusal(ad.processingErrorCode)}
          </p>
          <FileReplacer onChoose={(file) => void chooseReplacement(file)} label="Choose a different file" />
        </div>
      ) : null}

      {replacementProblem ? (
        <p role="alert" className="text-body font-bold text-danger">
          {replacementProblem}
        </p>
      ) : null}

      {needsFile ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-muted">{describeFileStatus('AWAITING_UPLOAD').hint} Choose the file again to finish the upload.</p>
          <FileChooser onChoose={(file) => void chooseReplacement(file)} label="Choose the audio file" />
        </div>
      ) : null}
    </div>
  );
}

/** A button that opens the file picker, for replacing a file that failed. */
function FileReplacer({ onChoose, label }: { onChoose: (file: File) => void; label: string }) {
  const inputReference = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="secondary" onClick={() => inputReference.current?.click()}>
        {label}
      </Button>
      <input
        ref={inputReference}
        type="file"
        accept={ACCEPTED_FILES}
        className="sr-only"
        tabIndex={-1}
        aria-label="Replacement audio file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          event.target.value = '';
        }}
      />
    </>
  );
}

export function AudioStep({
  stationId,
  clientName,
  ad,
  upload,
  chosen,
  titleProblem,
}: {
  stationId: string;
  clientName: string;
  ad: AdDetail | undefined;
  upload: UploadState | undefined;
  chosen: ChosenAudio;
  titleProblem: string | null;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-display">{ad ? 'Your audio' : 'Upload the ad'}</h1>
        <p className="text-body text-muted">
          For <strong className="text-ink">{clientName}</strong>
          {ad ? <Icon name="check" size={16} className="ml-1 inline text-success" /> : null}
        </p>
      </div>
      {ad || upload ? <UploadProgress stationId={stationId} ad={ad} upload={upload} /> : <ChooseAudio chosen={chosen} titleProblem={titleProblem} />}
    </div>
  );
}
