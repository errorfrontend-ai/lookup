import type { AdDetail } from '@lookup/contracts';
import { Icon } from '../../components/icons';
import { ProgressBar } from '../../components/progress-bar';
import type { UploadState } from './ad-upload-store';

type StageState = 'done' | 'current' | 'waiting' | 'todo';

interface Stage {
  id: string;
  state: StageState;
  label: string;
  note?: string;
}

/**
 * The three things that happen to the audio, in plain words: it goes up, it is checked, and (once the
 * recognition service is switched on) it is prepared so listeners' phones can recognise it. In this
 * version preparing never finishes by itself, so the last stage says so honestly.
 */
function stagesFor(ad: AdDetail | undefined, upload: UploadState | undefined): Stage[] {
  const isVerified = ad?.status === 'PROCESSING' || ad?.status === 'READY' || ad?.status === 'NEEDS_REVIEW';
  const phase = upload?.phase;
  const hasUploaded = isVerified || phase === 'checking' || phase === 'checked';
  const hasChecked = isVerified || phase === 'checked';

  const uploading: Stage = {
    id: 'upload',
    state: hasUploaded ? 'done' : phase === 'uploading' ? 'current' : 'todo',
    label: hasUploaded ? 'Uploaded' : phase === 'uploading' ? `Uploading ${upload?.percent ?? 0}%` : 'Upload the file',
  };
  const checking: Stage = {
    id: 'check',
    state: hasChecked ? 'done' : phase === 'checking' ? 'current' : 'todo',
    label: hasChecked ? 'Checked' : phase === 'checking' ? 'Checking the file…' : 'Check the file',
  };
  const preparing: Stage = {
    id: 'prepare',
    state: ad?.status === 'READY' ? 'done' : isVerified ? 'waiting' : 'todo',
    label: ad?.status === 'READY' ? 'Ready for listeners' : isVerified ? 'Not prepared for recognition yet' : 'Ready for listeners',
    note: isVerified && ad?.status !== 'READY' ? "This happens once Look Up's recognition service is switched on. You don't need to wait for it." : undefined,
  };
  return [uploading, checking, preparing];
}

/** The upload's progress, as a list of what has happened and what is happening. */
export function UploadStages({ ad, upload }: { ad: AdDetail | undefined; upload: UploadState | undefined }) {
  const stages = stagesFor(ad, upload);
  return (
    <div className="flex flex-col gap-3">
      {upload?.phase === 'uploading' ? <ProgressBar percent={upload.percent} label="Upload progress" /> : null}
      <ol aria-label="Upload progress" className="m-0 flex list-none flex-col gap-3 p-0 text-body">
        {stages.map((stage) => (
          <li key={stage.id} aria-current={stage.state === 'current' ? 'step' : undefined} className={`flex items-start gap-3 ${stage.state === 'todo' || stage.state === 'waiting' ? 'text-muted' : ''}`}>
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill ${
                stage.state === 'done' ? 'bg-success text-surface' : stage.state === 'current' ? 'border-[3px] border-accent border-r-accent-soft motion-safe:animate-spin' : stage.state === 'waiting' ? 'border-2 border-dashed border-muted' : 'border-2 border-line'
              }`}
            >
              {stage.state === 'done' ? <Icon name="check" size={14} /> : null}
            </span>
            <span className="flex flex-col">
              <span className={stage.state === 'todo' ? '' : 'font-bold'}>{stage.label}</span>
              {stage.note ? <span className="text-caption font-normal text-muted">{stage.note}</span> : null}
              <span className="sr-only">{stage.state === 'done' ? 'done' : stage.state === 'current' ? 'in progress' : stage.state === 'waiting' ? 'waiting' : 'not started'}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
