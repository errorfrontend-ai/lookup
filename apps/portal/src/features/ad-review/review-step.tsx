import { buildActionUri, type AdDetail, type PublishBlocker, readActionCard } from '@lookup/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { AdAudioPlayer } from '../../components/ad-audio-player';
import { Icon, type IconName } from '../../components/icons';
import { ListenerCardPreview } from '../../components/listener-card-preview';
import { PhoneWidthToggle, type PhoneWidth } from '../../components/phone-width-toggle';
import { ProgrammeRundown } from '../../components/programme-rundown';
import { FileStatusBadge } from '../../components/status-badges';
import { formatFileSize } from '../../formatting/format-file-size';
import { describeCampaignStatus, describeFileStatus } from '../../plain-words/ad-status-words';
import { PUBLISH_BLOCKER_WORDS } from '../../plain-words/publish-words';
import { describeButtonDestination } from '../ad-buttons/describe-button-destination';
import { ScheduleFacts } from '../ads/detail/schedule-facts';
import type { MemberStation } from '../stations/use-current-station';

const TYPE_ICONS: Record<'CALL' | 'WHATSAPP' | 'MAP' | 'LINK', IconName> = { CALL: 'phone', WHATSAPP: 'chat', MAP: 'pin', LINK: 'link' };
const TYPE_WORDS = { CALL: 'Call', WHATSAPP: 'WhatsApp', MAP: 'Directions', LINK: 'Website' } as const;

function Section({ title, editStep, editLabel, children }: { title: string; editStep: 'audio' | 'buttons' | 'schedule'; editLabel: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading">{title}</h2>
        <Link to={{ search: `?step=${editStep}` }} className="flex min-h-11 items-center rounded-md px-2 text-label text-accent underline underline-offset-4 hover:bg-accent-soft">
          {editLabel}
        </Link>
      </div>
      {children}
    </section>
  );
}

const UNSAVED_STEP_WORDS = { buttons: 'Save the buttons', schedule: 'Save the schedule' } as const;

/** Changes made in this visit that are not saved yet. Publish puts the saved version on air, so they come first. */
function UnsavedChanges({ steps }: { steps: ReadonlyArray<'buttons' | 'schedule'> }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft p-4">
      <span className="text-label text-ink">Some changes aren't saved yet</span>
      <span className="text-body text-ink">Publishing puts the saved version on air. Go back and save your changes first.</span>
      <div className="flex flex-wrap gap-x-4">
        {steps.map((step) => (
          <Link key={step} to={{ search: `?step=${step}` }} className="flex min-h-11 items-center text-label text-accent underline underline-offset-4">
            {UNSAVED_STEP_WORDS[step]}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Whether the ad can be published, and if not, what stops it and where to fix each thing. */
function Readiness({ blockers, isPublished, campaignStatus }: { blockers: PublishBlocker[]; isPublished: boolean; campaignStatus: AdDetail['campaign'] }) {
  if (isPublished && campaignStatus) {
    const words = describeCampaignStatus(campaignStatus.displayStatus);
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-line-soft bg-surface p-4">
        <Icon name="check" size={20} className="mt-0.5 shrink-0 text-success" />
        <div className="flex flex-col">
          <span className="text-label">Published · {words.label}</span>
          <span className="text-caption text-muted">Changes to the buttons and times take effect as soon as they are saved.</span>
        </div>
      </div>
    );
  }
  if (blockers.length === 0) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-success bg-success-soft p-4">
        <Icon name="check" size={20} className="mt-0.5 shrink-0 text-success" />
        <div className="flex flex-col">
          <span className="text-label">Ready to publish</span>
          <span className="text-caption text-muted">Publishing puts this ad on the schedule below. You can still change its buttons and times afterwards.</span>
        </div>
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-danger bg-danger-soft p-4">
      <span className="flex items-center gap-2 text-label text-danger">
        <Icon name="alert" size={18} />
        Not ready to publish yet
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {blockers.map((blocker) => {
          const words = PUBLISH_BLOCKER_WORDS[blocker];
          return (
            <li key={blocker} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body">{words.problem}</span>
              <Link to={{ search: `?step=${words.step}` }} className="flex min-h-11 items-center rounded-md px-2 text-label text-accent underline underline-offset-4 hover:bg-surface">
                {words.fixLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The last step: everything in one place to check before the ad goes on air. Each part has its own
 * "change" link back to its step, and what stops publishing (if anything) is listed with a link to fix it.
 */
export function ReviewStep({
  ad,
  station,
  blockers,
  unsavedSteps = [],
}: {
  ad: AdDetail;
  station: MemberStation;
  blockers: PublishBlocker[];
  /** Steps with changes made in this visit that are not saved yet. */
  unsavedSteps?: ReadonlyArray<'buttons' | 'schedule'>;
}) {
  const [phoneWidth, setPhoneWidth] = useState<PhoneWidth>(320);
  const isPublished = Boolean(ad.campaign && ad.campaign.displayStatus !== 'DRAFT');
  const hasAudio = ad.status !== 'AWAITING_UPLOAD' && ad.status !== 'FAILED';
  const read = ad.actionCard ? readActionCard(ad.actionCard) : null;
  const actions = read ? [...read.visibleActions, ...read.moreOptionsActions] : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-display">{isPublished ? 'Your ad' : 'Review and publish'}</h1>
        <p className="text-body text-muted">{isPublished ? 'Everything about this ad, in one place.' : 'Check everything below. Publishing puts the ad on the schedule you set.'}</p>
      </div>

      {unsavedSteps.length > 0 ? <UnsavedChanges steps={unsavedSteps} /> : null}
      <Readiness blockers={blockers} isPublished={isPublished} campaignStatus={ad.campaign} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-4">
          <Section title="Audio" editStep="audio" editLabel="Change audio">
            <p className="text-body">
              <strong>{ad.title}</strong> for {ad.client.name}
            </p>
            {hasAudio ? <AdAudioPlayer stationId={station.id} adId={ad.id} adTitle={ad.title} variant="full" /> : null}
            <div className="flex flex-wrap items-center gap-2">
              <FileStatusBadge status={ad.status} />
              <span className="text-caption text-muted">{describeFileStatus(ad.status).hint}</span>
            </div>
            <p className="text-caption text-muted">
              {ad.uploadedFileName ?? 'No file yet'}
              {ad.uploadSizeBytes ? ` · ${formatFileSize(ad.uploadSizeBytes)}` : ''}
            </p>
          </Section>

          <Section title="Buttons" editStep="buttons" editLabel="Change buttons">
            {actions.length === 0 ? (
              <p className="text-body text-muted">No buttons yet. Listeners would have nothing to tap.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
                {actions.map((action) => {
                  const address = buildActionUri(action);
                  return (
                    <li key={action.id} className="flex items-start gap-3 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent">
                        <Icon name={TYPE_ICONS[action.type]} size={18} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-label">{action.label}</span>
                        <span className="text-caption text-muted">{TYPE_WORDS[action.type]}</span>
                        <span className="break-words text-body">{describeButtonDestination(action)}</span>
                      </div>
                      {address ? (
                        <a href={address} target={address.startsWith('https:') ? '_blank' : undefined} rel="noopener noreferrer" aria-label={`Try “${action.label}”`} className="flex min-h-11 items-center rounded-md px-3 text-label text-accent hover:bg-accent-soft">
                          Try it
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <Section title="When it airs" editStep="schedule" editLabel="Change the schedule">
            {ad.schedule ? (
              <>
                <ScheduleFacts schedule={ad.schedule} />
                <ProgrammeRundown windows={ad.schedule.timeWindows} />
              </>
            ) : (
              <p className="text-body text-muted">Not scheduled yet. Set the dates and hours this ad airs.</p>
            )}
          </Section>
        </div>

        <section aria-label="What listeners see" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5 lg:sticky lg:top-28">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-heading">What listeners see</h2>
            <PhoneWidthToggle value={phoneWidth} onChange={setPhoneWidth} />
          </div>
          <ListenerCardPreview card={ad.actionCard} adTitle={ad.title} clientName={ad.client.name} stationName={station.name} frequencyLabel={station.frequencyLabel} phoneWidth={phoneWidth} />
        </section>
      </div>
    </div>
  );
}
