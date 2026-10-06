import type { AdSummary } from '@lookup/contracts';
import { Link } from 'react-router';
import { AdAudioPlayer } from '../../components/ad-audio-player';
import { ButtonLink } from '../../components/button';
import { ClientAvatar } from '../../components/client-avatar';
import { Icon } from '../../components/icons';
import { CampaignStatusBadge, FileStatusBadge } from '../../components/status-badges';
import { describeScheduleSummary, formatDateRange, formatStationDate } from '../../formatting/describe-schedule';
import { formatRelativeTime } from '../../formatting/format-relative-time';
import { describeAttentionReason } from '../../plain-words/ad-status-words';
import { BUILT_WIZARD_STEPS, setupStepForSummary } from '../new-ad/wizard-steps';

/** Whether this ad has audio to play: only once its upload has arrived. */
function hasPlayableAudio(ad: AdSummary): boolean {
  return ad.status !== 'AWAITING_UPLOAD' && ad.status !== 'FAILED';
}

/** The most serious reason this ad needs attention, in a sentence (null when it doesn't). */
function attentionSentence(ad: AdSummary): string | null {
  const reason = ad.attentionReasons[0];
  if (!reason) return null;
  return describeAttentionReason(reason, ad.client.name, ad.campaign ? formatStationDate(ad.campaign.endsOn) : null).detail;
}

function AdIdentity({ ad, stationId }: { ad: AdSummary; stationId: string }) {
  const attention = attentionSentence(ad);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ClientAvatar clientId={ad.client.id} name={ad.client.name} />
      <div className="flex min-w-0 flex-col">
        <Link to={`/stations/${stationId}/ads/${ad.id}`} className="truncate text-heading text-ink no-underline hover:text-accent hover:underline">
          {ad.title}
        </Link>
        <span className="truncate text-caption text-muted">{ad.client.name}</span>
        {attention ? (
          <span className="mt-1 flex items-start gap-1.5 text-caption font-bold text-danger">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            {attention}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function WhenItAirs({ ad }: { ad: AdSummary }) {
  if (!ad.campaign) {
    return (
      <span className="text-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No times set</span>
      </span>
    );
  }
  return (
    <div className="flex flex-col">
      <span>{describeScheduleSummary(ad.campaign.timeWindows)}</span>
      <span className="text-caption text-muted">{formatDateRange(ad.campaign.startsOn, ad.campaign.endsOn)}</span>
    </div>
  );
}

/** For an ad that is not finished: the way back into setup, at the step it needs (owners and managers only, and only to steps that exist). */
function SetupLink({ ad, stationId, canChange }: { ad: AdSummary; stationId: string; canChange: boolean }) {
  const step = setupStepForSummary(ad);
  if (!canChange || !step || !BUILT_WIZARD_STEPS.has(step)) return null;
  return (
    <ButtonLink variant="secondary" to={`/stations/${stationId}/ads/${ad.id}/setup?step=${step}`} aria-label={`${ad.status === 'FAILED' ? 'Upload again' : 'Continue setup'}: ${ad.title}`} className="self-start whitespace-nowrap">
      {ad.status === 'FAILED' ? 'Upload again' : 'Continue setup'}
    </ButtonLink>
  );
}

function PlayControl({ ad, stationId }: { ad: AdSummary; stationId: string }) {
  if (!hasPlayableAudio(ad)) return <span className="size-11 shrink-0" aria-hidden="true" />;
  return <AdAudioPlayer stationId={stationId} adId={ad.id} adTitle={ad.title} />;
}

/** The ads as a table, for wide screens. */
export function AdTable({ ads, stationId, canChange }: { ads: AdSummary[]; stationId: string; canChange: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line-soft bg-surface">
      <table className="w-full border-collapse text-left text-label">
        <caption className="sr-only">Your ads</caption>
        <thead>
          <tr className="bg-ground text-muted">
            <th scope="col" className="px-4 py-3">Ad</th>
            <th scope="col" className="px-3 py-3">Campaign</th>
            <th scope="col" className="px-3 py-3">Audio</th>
            <th scope="col" className="px-3 py-3">When it airs</th>
            <th scope="col" className="px-3 py-3">Changed</th>
            <th scope="col" className="px-3 py-3">
              <span className="sr-only">Play</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ads.map((ad) => (
            <tr key={ad.id} className="border-t border-line-soft align-middle">
              <th scope="row" className="max-w-xs px-4 py-3 text-left font-normal">
                <AdIdentity ad={ad} stationId={stationId} />
              </th>
              <td className="px-3 py-3">
                <CampaignStatusBadge status={ad.campaign?.displayStatus ?? null} />
              </td>
              <td className="px-3 py-3">
                <div className="flex flex-col items-start gap-2">
                  <FileStatusBadge status={ad.status} />
                  <SetupLink ad={ad} stationId={stationId} canChange={canChange} />
                </div>
              </td>
              <td className="px-3 py-3">
                <WhenItAirs ad={ad} />
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-muted">{formatRelativeTime(ad.updatedAt)}</td>
              <td className="px-3 py-2">
                <PlayControl ad={ad} stationId={stationId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ads as cards, for phones. */
export function AdCards({ ads, stationId, canChange }: { ads: AdSummary[]; stationId: string; canChange: boolean }) {
  return (
    <ul className="flex flex-col gap-3">
      {ads.map((ad) => (
        <li key={ad.id}>
          <article className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <AdIdentity ad={ad} stationId={stationId} />
              <PlayControl ad={ad} stationId={stationId} />
            </div>
            <div className="flex flex-wrap gap-2">
              <CampaignStatusBadge status={ad.campaign?.displayStatus ?? null} />
              <FileStatusBadge status={ad.status} />
            </div>
            <SetupLink ad={ad} stationId={stationId} canChange={canChange} />
            <div className="flex flex-col gap-0.5 text-label text-ink">
              <WhenItAirs ad={ad} />
              <span className="text-caption text-muted">Changed {formatRelativeTime(ad.updatedAt)}</span>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}
