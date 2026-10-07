import type { AdDetail } from '@lookup/contracts';
import { ButtonLink } from '../../../components/button';
import { ProgrammeRundown } from '../../../components/programme-rundown';
import { canChangeStationContent, type MemberStation } from '../../stations/use-current-station';
import { ScheduleFacts } from './schedule-facts';

/** When the ad airs: the week as a rundown, and the same schedule written out. */
export function AdScheduleTab({ ad, station }: { ad: AdDetail; station: MemberStation }) {
  const editPath = `/stations/${station.id}/ads/${ad.id}/setup?step=schedule`;
  const canEdit = canChangeStationContent(station);
  if (!ad.schedule) {
    return (
      <section className="rounded-lg border border-line-soft bg-surface p-5">
        <h2 className="text-heading">Not scheduled yet</h2>
        <p className="mt-1 text-body text-muted">Set the dates and hours this ad airs, then publish it so listeners get its buttons.</p>
        {canEdit ? (
          <ButtonLink to={editPath} className="mt-3">
            Set the schedule
          </ButtonLink>
        ) : null}
      </section>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-label="The week" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
        <h2 className="text-heading">The week</h2>
        <ProgrammeRundown windows={ad.schedule.timeWindows} />
      </section>
      <section aria-label="Schedule details" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-heading">Details</h2>
          {canEdit ? (
            <ButtonLink to={editPath} variant="secondary">
              Edit schedule
            </ButtonLink>
          ) : null}
        </div>
        <ScheduleFacts schedule={ad.schedule} />
      </section>
    </div>
  );
}
