import { type AdDetail } from '@lookup/contracts';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { ConfirmDialog } from '../../components/modal-dialog';
import { Skeleton } from '../../components/skeleton';
import { useToast } from '../../components/toast-region';
import { useAd } from '../ads/use-ad-detail';
import { useClients } from '../clients/use-clients';
import { useRequiredCurrentStation } from '../stations/use-current-station';
import { startUpload, useUploadState } from './ad-upload-store';
import { AudioStep } from './audio-step';
import { ClientStep } from './client-step';
import { useChosenAudio } from './use-chosen-audio';
import { useCreateAd } from './use-create-ad';
import { type SaveStatus, WizardLayout } from './wizard-layout';
import { firstIncompleteStep, isWizardStepId, type WizardStepId } from './wizard-steps';

/** Steps that exist so far. The buttons, schedule and review steps are added next; until then the wizard stops after the audio. */
const BUILT_STEPS: ReadonlySet<WizardStepId> = new Set(['client', 'audio']);

function createFailureWords(error: unknown): string {
  if (error instanceof ApiError && error.fields.some((field) => field.path === 'clientId' && field.code === 'unknown_client')) return 'This client no longer exists. Go back and choose another.';
  return "We couldn't create the ad.";
}

/**
 * Setting up an ad: who it is for, then its audio. The ad does not exist until "Upload ad" is pressed
 * (nothing is saved before that, and the screen says so); from then on it is a draft that can be left
 * and come back to.
 */
export function AdSetupPage() {
  const station = useRequiredCurrentStation();
  const { adId } = useParams();
  const [searchParameters] = useSearchParams();
  const navigate = useNavigate();
  const showToast = useToast();

  const ad = useAd(station.id, adId ?? '', Boolean(adId));
  const upload = useUploadState(adId);
  const clients = useClients(station.id);
  const createAd = useCreateAd(station.id);
  const chosen = useChosenAudio();

  const [clientId, setClientId] = useState<string | null>(null);
  const [step, setStep] = useState<'client' | 'audio'>('client');
  const [isLeaving, setIsLeaving] = useState(false);

  const adsPath = `/stations/${station.id}/ads`;
  const detail: AdDetail | undefined = ad.data;
  const chosenClientId = detail?.client.id ?? clientId;
  const clientName = detail?.client.name ?? clients.data?.find((client) => client.id === chosenClientId)?.name ?? null;

  const requestedStep = searchParameters.get('step');
  const stepInAddress = isWizardStepId(requestedStep) ? requestedStep : null;
  const [resumeStep, setResumeStep] = useState<WizardStepId | null>(null);
  const currentStep: WizardStepId = adId ? (stepInAddress ?? resumeStep ?? firstIncompleteStep(detail ?? null, upload)) : step;

  // Where setup resumes is worked out once, when the ad has loaded, then held here and put in the address
  // (so a refresh or a shared link keeps it). Worked out live it would move the person to the next step
  // the moment an upload started. It is held here too because the address can take a moment to catch up.
  const mustPinStep = Boolean(adId && detail && !stepInAddress && !resumeStep);
  useEffect(() => {
    if (!mustPinStep) return;
    const resume = firstIncompleteStep(detail ?? null, upload);
    setResumeStep(resume);
    void navigate({ search: `?step=${resume}` }, { replace: true });
  }, [mustPinStep, detail, upload, navigate]);

  const saveStatus: SaveStatus = createAd.isPending ? 'saving' : adId ? 'saved' : 'nothing-saved';
  const titleProblem = chosen.title.trim() === '' ? 'Give the ad a title.' : null;
  const canUpload = Boolean(chosenClientId && chosen.file && chosen.check?.isAcceptable && !titleProblem);
  const isUploadRunning = upload?.phase === 'uploading' || upload?.phase === 'checking';

  const uploadAd = () => {
    const { file, check } = chosen;
    if (!chosenClientId || !file || !check?.isAcceptable || titleProblem) return;
    createAd.mutate(
      { clientId: chosenClientId, title: chosen.title.trim(), upload: { fileName: file.name, contentType: check.contentType, sizeBytes: file.size } },
      {
        onSuccess: (created) => {
          startUpload({ stationId: station.id, adId: created.adId, file, peaks: check.facts.peaks, instructions: created.upload });
          void navigate(`/stations/${station.id}/ads/${created.adId}/setup?step=audio`, { replace: true });
        },
      },
    );
  };

  const leave = () => {
    if (adId) {
      showToast(isUploadRunning ? 'Draft saved. The upload carries on — keep this tab open until it finishes.' : 'Draft saved. Continue setup from Drafts any time.');
      void navigate(`${adsPath}?view=drafts`);
    } else {
      void navigate(adsPath);
    }
  };

  const askToLeave = () => {
    if (!adId && (chosen.file || clientId)) setIsLeaving(true);
    else leave();
  };

  const adIsMissing = ad.error instanceof ApiError && ad.error.httpStatus === 404;

  let body;
  let footer;
  if (adId && ad.isPending) {
    body = <Skeleton className="mx-auto h-64 w-full max-w-xl" />;
    footer = <span />;
  } else if (adId && adIsMissing) {
    body = (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <h1 className="text-display">We couldn't find that ad</h1>
        <p className="text-body text-muted">It may have been removed.</p>
        <Link to={adsPath} className="text-label text-accent underline underline-offset-4">
          Go to your ads
        </Link>
      </div>
    );
    footer = <span />;
  } else if (adId && ad.isError) {
    body = (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3">
        <ErrorNotice error={ad.error} title="We couldn't load this ad" />
        <Button variant="secondary" onClick={() => void ad.refetch()}>
          Try again
        </Button>
      </div>
    );
    footer = <span />;
  } else if (currentStep === 'client' && !adId) {
    body = <ClientStep stationId={station.id} selectedClientId={clientId} onSelect={setClientId} />;
    footer = (
      <>
        <Button variant="secondary" onClick={askToLeave}>
          Cancel
        </Button>
        <Button disabled={!clientId} onClick={() => setStep('audio')}>
          Next: Audio
        </Button>
      </>
    );
  } else if (currentStep === 'client' || currentStep === 'audio') {
    body = (
      <>
        <AudioStep stationId={station.id} clientName={clientName ?? 'your client'} ad={detail} upload={upload} chosen={chosen} titleProblem={chosen.file ? titleProblem : null} />
        {createAd.isError ? (
          <div className="mx-auto mt-4 max-w-xl">
            <ErrorNotice error={createAd.error} title={createFailureWords(createAd.error)} />
          </div>
        ) : null}
      </>
    );
    footer = adId ? (
      <>
        <span />
        <Button onClick={leave}>Save and close</Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={() => setStep('client')}>
          Back
        </Button>
        <Button disabled={!canUpload} isBusy={createAd.isPending} busyLabel="Uploading…" onClick={uploadAd}>
          Upload ad
        </Button>
      </>
    );
  } else {
    body = (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <h1 className="text-display">This step is coming next</h1>
        <p className="text-body text-muted">Adding the buttons and the schedule here is the next thing we are building. Your draft is saved.</p>
        <Link to={adsPath} className="text-label text-accent underline underline-offset-4">
          Go to your ads
        </Link>
      </div>
    );
    footer = <span />;
  }

  return (
    <>
      <WizardLayout
        title={detail ? detail.title : chosen.title.trim() || 'Untitled ad'}
        clientName={clientName}
        currentStep={BUILT_STEPS.has(currentStep) ? currentStep : 'audio'}
        completedSteps={new Set<WizardStepId>(chosenClientId ? ['client'] : [])}
        saveStatus={saveStatus}
        onExit={askToLeave}
        footer={footer}
      >
        {body}
      </WizardLayout>
      {isLeaving ? (
        <ConfirmDialog title="Leave without saving?" confirmLabel="Leave" cancelLabel="Keep working" onConfirm={() => void navigate(adsPath)} onClose={() => setIsLeaving(false)}>
          <p className="text-body text-muted">Nothing is saved until you upload the ad. If you leave now, you will need to choose the client and the file again.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
