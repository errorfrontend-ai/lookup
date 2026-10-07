import { type AdDetail } from '@lookup/contracts';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { describeScheduleSummary, formatDateRange } from '../../formatting/describe-schedule';
import { ConfirmDialog } from '../../components/modal-dialog';
import { Skeleton } from '../../components/skeleton';
import { useToast } from '../../components/toast-region';
import { describePublished } from '../../plain-words/publish-words';
import { ButtonsStep } from '../ad-buttons/buttons-step';
import { useButtonsDraft } from '../ad-buttons/use-buttons-draft';
import { blockersFromApiFields, findPublishBlockers } from '../ad-review/find-publish-blockers';
import { ReviewStep } from '../ad-review/review-step';
import { usePublishAd } from '../ad-review/use-publish-ad';
import { ScheduleStep } from '../ad-schedule/schedule-step';
import { useScheduleDraft } from '../ad-schedule/use-schedule-draft';
import { useAd } from '../ads/use-ad-detail';
import { useClients } from '../clients/use-clients';
import { useRequiredCurrentStation } from '../stations/use-current-station';
import { useStationProfile } from '../stations/use-station-profile';
import { startUpload, useUploadState } from './ad-upload-store';
import { AudioStep } from './audio-step';
import { ClientStep } from './client-step';
import { useChosenAudio } from './use-chosen-audio';
import { useCreateAd } from './use-create-ad';
import { WizardFooter } from './wizard-footer';
import { type SaveStatus, WizardLayout } from './wizard-layout';
import { firstIncompleteStep, isWizardStepId, type WizardStepId } from './wizard-steps';

type LeaveWarning = 'nothing-saved' | 'unsaved-changes';

function createFailureWords(error: unknown): string {
  if (error instanceof ApiError && error.fields.some((field) => field.path === 'clientId' && field.code === 'unknown_client')) return 'This client no longer exists. Go back and choose another.';
  return "We couldn't create the ad.";
}

/** Takes the person to the first thing to fix, once the problems have been drawn. */
function focusFirstProblem() {
  window.setTimeout(() => document.querySelector<HTMLElement>('main [aria-invalid="true"]')?.focus(), 0);
}

/**
 * Setting up an ad: who it is for, its audio, its buttons, then when it airs. The ad does not exist
 * until "Upload ad" is pressed (nothing is saved before that, and the screen says so); from then on it
 * is a draft that can be left and come back to. The same screen changes the buttons and times of an ad
 * that is already published.
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
  const [leaveWarning, setLeaveWarning] = useState<LeaveWarning | null>(null);
  const [isConfirmingPublish, setIsConfirmingPublish] = useState(false);

  const adsPath = `/stations/${station.id}/ads`;
  const detail: AdDetail | undefined = ad.data;

  const requestedStep = searchParameters.get('step');
  const stepInAddress = isWizardStepId(requestedStep) ? requestedStep : null;
  const [resumeStep, setResumeStep] = useState<WizardStepId | null>(null);
  const currentStep: WizardStepId = adId ? (stepInAddress ?? resumeStep ?? firstIncompleteStep(detail ?? null, upload)) : step;

  const buttons = useButtonsDraft(station.id, adId, detail);
  // The station's time zone is only needed to know "today" for a new schedule.
  const profile = useStationProfile(station.id, (currentStep === 'schedule' || currentStep === 'review') && Boolean(adId));
  const schedule = useScheduleDraft(station.id, adId, detail, profile.data?.timeZone);
  const publish = usePublishAd(station.id, adId ?? '');

  const chosenClientId = detail?.client.id ?? clientId;
  const clientName = detail?.client.name ?? clients.data?.find((client) => client.id === chosenClientId)?.name ?? null;
  /** An ad that is already published is being changed, not set up. */
  const isEditing = Boolean(detail?.campaign && detail.campaign.displayStatus !== 'DRAFT');

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

  const hasUnsavedChanges = buttons.isDirty || schedule.isDirty;
  const saveStatus: SaveStatus = createAd.isPending || buttons.isSaving || schedule.isSaving ? 'saving' : !adId ? 'nothing-saved' : hasUnsavedChanges ? 'unsaved' : 'saved';
  const titleProblem = chosen.title.trim() === '' ? 'Give the ad a title.' : null;
  const canUpload = Boolean(chosenClientId && chosen.file && chosen.check?.isAcceptable && !titleProblem);
  const isUploadRunning = upload?.phase === 'uploading' || upload?.phase === 'checking';
  const audioHasArrived = Boolean(detail) && firstIncompleteStep(detail ?? null, upload) !== 'audio';

  const completedSteps = new Set<WizardStepId>();
  if (chosenClientId) completedSteps.add('client');
  if (audioHasArrived) completedSteps.add('audio');
  if (detail?.actionCard) completedSteps.add('buttons');
  if (detail?.schedule) completedSteps.add('schedule');

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

  const goToStep = (target: WizardStepId) => void navigate({ search: `?step=${target}` });

  /** Leaves setup: a draft goes back to Drafts, a published ad back to its own page. `savedMessage` says what was saved, when something was. */
  const leave = (savedMessage?: string) => {
    if (!adId) {
      void navigate(adsPath);
      return;
    }
    if (isEditing) {
      showToast(savedMessage ?? 'Saved.');
      const tab = currentStep === 'buttons' ? '?tab=buttons' : currentStep === 'schedule' ? '?tab=schedule' : '';
      void navigate(`${adsPath}/${adId}${tab}`);
      return;
    }
    showToast(savedMessage ?? (isUploadRunning ? 'Draft saved. The upload carries on — keep this tab open until it finishes.' : 'Draft saved. Continue setup from Drafts any time.'));
    void navigate(`${adsPath}?view=drafts`);
  };

  const askToLeave = () => {
    if (!adId && (chosen.file || clientId)) setLeaveWarning('nothing-saved');
    else if (hasUnsavedChanges) setLeaveWarning('unsaved-changes');
    else leave();
  };

  /** Saves the buttons when they need it, then goes on or closes. A failed save stays here with the problems shown. */
  const finishButtons = async (then: 'close' | 'continue') => {
    if (buttons.isDirty || !buttons.hasSavedCard) {
      if (!(await buttons.save())) {
        focusFirstProblem();
        return;
      }
    }
    if (then === 'continue') goToStep('schedule');
    else leave(isEditing ? 'Buttons saved.' : 'Buttons saved. Continue setup from Drafts any time.');
  };

  /** Saves the schedule when it needs it, then goes on or closes. An ended ad given new dates becomes a new draft, which still has to be published, so it goes on to the review. */
  const finishSchedule = async (then: 'close' | 'continue') => {
    let current = detail;
    if (schedule.isDirty || !schedule.hasSavedSchedule) {
      const saved = await schedule.save();
      if (!saved) {
        focusFirstProblem();
        return;
      }
      current = saved;
    }
    if (then === 'continue') goToStep('review');
    else if (isEditing && current?.campaign?.displayStatus === 'DRAFT') {
      showToast('Schedule saved. Publish it when you are ready.');
      goToStep('review');
    } else leave('Schedule saved.');
  };

  const publishAd = () => {
    publish.mutate(undefined, {
      onSuccess: (published) => {
        setIsConfirmingPublish(false);
        showToast(describePublished(published, schedule.today));
        void navigate(`${adsPath}/${published.id}`);
      },
      onError: () => setIsConfirmingPublish(false),
    });
  };

  const adIsMissing = ad.error instanceof ApiError && ad.error.httpStatus === 404;

  let body;
  let footer;
  if (adId && ad.isPending) {
    body = <Skeleton className="mx-auto h-64 w-full max-w-xl" />;
    footer = <WizardFooter />;
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
    footer = <WizardFooter />;
  } else if (adId && ad.isError) {
    body = (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3">
        <ErrorNotice error={ad.error} title="We couldn't load this ad" />
        <Button variant="secondary" onClick={() => void ad.refetch()}>
          Try again
        </Button>
      </div>
    );
    footer = <WizardFooter />;
  } else if (currentStep === 'client' && !adId) {
    body = <ClientStep stationId={station.id} selectedClientId={clientId} onSelect={setClientId} />;
    footer = (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={askToLeave}>
            Cancel
          </Button>
        }
        primary={
          <Button disabled={!clientId} onClick={() => setStep('audio')}>
            Next: Audio
          </Button>
        }
      />
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
      <WizardFooter
        secondary={
          <Button variant="secondary" onClick={askToLeave}>
            Save and close
          </Button>
        }
        primary={
          <Button disabled={!audioHasArrived} onClick={() => goToStep('buttons')}>
            Next: Buttons
          </Button>
        }
      />
    ) : (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => setStep('client')}>
            Back
          </Button>
        }
        primary={
          <Button disabled={!canUpload} isBusy={createAd.isPending} busyLabel="Uploading…" onClick={uploadAd}>
            Upload ad
          </Button>
        }
      />
    );
  } else if (currentStep === 'buttons' && detail) {
    body = !buttons.canEdit ? (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <h1 className="text-display">These buttons can't be changed here</h1>
        <p className="text-body text-muted">They were saved in a newer form than this page understands, and changing them here could lose some. Ask Look Up support for help.</p>
      </div>
    ) : !buttons.isReady ? (
      <Skeleton className="h-64 w-full" />
    ) : (
      <div className="flex flex-col gap-4">
        <ButtonsStep ad={detail} station={station} drafts={buttons.drafts} onChange={buttons.changeDrafts} validation={buttons.validation} apiProblems={buttons.apiProblems} showAllProblems={buttons.showAllProblems} />
        {buttons.saveError ? <ErrorNotice error={buttons.saveError} title="We couldn't save the buttons" /> : null}
      </div>
    );
    const isBusy = buttons.isSaving;
    const isNotReady = !buttons.canEdit || !buttons.isReady;
    footer = (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => goToStep('audio')}>
            Back
          </Button>
        }
        secondary={
          <Button variant="secondary" disabled={isNotReady || isBusy} onClick={() => void finishButtons('close')}>
            Save and close
          </Button>
        }
        primary={
          <Button disabled={isNotReady} isBusy={isBusy} busyLabel="Saving…" onClick={() => void finishButtons('continue')}>
            Save and continue
          </Button>
        }
      />
    );
  } else if (currentStep === 'schedule' && detail) {
    const needsTimeZone = !detail.schedule && !profile.data;
    body = profile.isError && needsTimeZone ? (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3">
        <ErrorNotice error={profile.error} title="We couldn't load your station's details" />
        <Button variant="secondary" onClick={() => void profile.refetch()}>
          Try again
        </Button>
      </div>
    ) : !schedule.isReady ? (
      <Skeleton className="h-64 w-full" />
    ) : (
      <div className="flex flex-col gap-4">
        <ScheduleStep
          draft={schedule.draft}
          onChange={schedule.changeDraft}
          validation={schedule.validation}
          apiProblems={schedule.apiProblems}
          showAllProblems={schedule.showAllProblems}
          timeZone={schedule.timeZone}
          today={schedule.today}
        />
        {schedule.showAllProblems && schedule.validation.problemCount > 0 ? (
          <p role="alert" className="rounded-md border border-danger bg-danger-soft px-4 py-3 text-body font-bold text-danger">
            {schedule.validation.problemCount === 1 ? '1 thing' : `${schedule.validation.problemCount} things`} to fix before this schedule can be saved.
          </p>
        ) : null}
        {schedule.saveError ? <ErrorNotice error={schedule.saveError} title="We couldn't save the schedule" /> : null}
      </div>
    );
    footer = isEditing ? (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => goToStep('buttons')}>
            Back
          </Button>
        }
        primary={
          <Button disabled={!schedule.isReady} isBusy={schedule.isSaving} busyLabel="Saving…" onClick={() => void finishSchedule('close')}>
            Save and close
          </Button>
        }
      />
    ) : (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => goToStep('buttons')}>
            Back
          </Button>
        }
        secondary={
          <Button variant="secondary" disabled={!schedule.isReady || schedule.isSaving} onClick={() => void finishSchedule('close')}>
            Save and close
          </Button>
        }
        primary={
          <Button disabled={!schedule.isReady} isBusy={schedule.isSaving} busyLabel="Saving…" onClick={() => void finishSchedule('continue')}>
            Save and continue
          </Button>
        }
      />
    );
  } else if (detail) {
    // The last step. What the API refused to publish for (if it did) is shown over what was worked out here, since it checked for real.
    const refusedFor = publish.error instanceof ApiError && publish.error.code === 'AD_NOT_READY_TO_PUBLISH' ? blockersFromApiFields(publish.error.fields) : [];
    const blockers = refusedFor.length > 0 ? refusedFor : findPublishBlockers(detail, schedule.today);
    body = (
      <div className="flex flex-col gap-4">
        <ReviewStep ad={detail} station={station} blockers={blockers} />
        {publish.isError && refusedFor.length === 0 ? <ErrorNotice error={publish.error} title="We couldn't publish this ad" /> : null}
      </div>
    );
    footer = isEditing ? (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => goToStep('schedule')}>
            Back
          </Button>
        }
        primary={<Button onClick={() => leave()}>Close</Button>}
      />
    ) : (
      <WizardFooter
        back={
          <Button variant="secondary" onClick={() => goToStep('schedule')}>
            Back
          </Button>
        }
        secondary={
          <Button variant="secondary" onClick={askToLeave}>
            Save and close
          </Button>
        }
        primary={
          <Button disabled={blockers.length > 0} isBusy={publish.isPending} busyLabel="Publishing…" onClick={() => setIsConfirmingPublish(true)}>
            Publish
          </Button>
        }
      />
    );
  } else {
    body = <Skeleton className="mx-auto h-64 w-full max-w-xl" />;
    footer = <WizardFooter />;
  }

  return (
    <>
      <WizardLayout
        title={detail ? detail.title : chosen.title.trim() || 'Untitled ad'}
        clientName={clientName}
        isEditing={isEditing}
        currentStep={currentStep}
        completedSteps={completedSteps}
        saveStatus={saveStatus}
        onExit={askToLeave}
        footer={footer}
      >
        {body}
      </WizardLayout>
      {isConfirmingPublish && detail ? (
        <ConfirmDialog title={`Publish “${detail.title}”?`} confirmLabel="Publish" cancelLabel="Not yet" tone="primary" isBusy={publish.isPending} onConfirm={publishAd} onClose={() => setIsConfirmingPublish(false)}>
          <p>
            It goes on air by the schedule you set
            {detail.schedule ? `: ${describeScheduleSummary(detail.schedule.timeWindows)}, ${formatDateRange(detail.schedule.startsOn, detail.schedule.endsOn)}` : ''}. You can still change its buttons and times afterwards.
          </p>
        </ConfirmDialog>
      ) : null}
      {leaveWarning ? (
        <ConfirmDialog
          title={leaveWarning === 'unsaved-changes' ? 'Leave without saving your changes?' : 'Leave without saving?'}
          confirmLabel="Leave"
          cancelLabel="Keep working"
          onConfirm={() => {
            setLeaveWarning(null);
            void navigate(isEditing && adId ? `${adsPath}/${adId}` : adId ? `${adsPath}?view=drafts` : adsPath);
          }}
          onClose={() => setLeaveWarning(null)}
        >
          <p className="text-body text-muted">
            {leaveWarning === 'unsaved-changes'
              ? "The changes you made haven't been saved. If you leave now, they will be lost."
              : 'Nothing is saved until you upload the ad. If you leave now, you will need to choose the client and the file again.'}
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
