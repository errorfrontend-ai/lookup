import type { AdSchedule } from '@lookup/contracts';
import { describeGracePeriod, describeTimeWindow, formatDateRange, hoursOnAirPerWeek } from '../../../formatting/describe-schedule';

/** A schedule written out: dates, each time slot, how long after a slot still counts, and any tap limit. */
export function ScheduleFacts({ schedule }: { schedule: AdSchedule | null }) {
  if (!schedule) return <p className="text-body text-muted">Not scheduled yet. Set when this ad airs, then publish it.</p>;
  const hoursPerWeek = hoursOnAirPerWeek(schedule.timeWindows);
  return (
    <dl className="m-0 grid gap-x-4 gap-y-2 text-body sm:grid-cols-[10rem_1fr]">
      <dt className="text-label text-muted">Dates</dt>
      <dd className="m-0">{formatDateRange(schedule.startsOn, schedule.endsOn)}</dd>
      <dt className="text-label text-muted">Times</dt>
      <dd className="m-0 flex flex-col">
        {schedule.timeWindows.map((window) => (
          <span key={`${window.daysOfWeek.join('')}-${window.localStartTime}-${window.localEndTime}`}>{describeTimeWindow(window)}</span>
        ))}
        <span className="text-caption text-muted">
          {hoursPerWeek === 1 ? '1 hour a week' : `${hoursPerWeek} hours a week`} · in station time ({schedule.stationTimeZone})
        </span>
      </dd>
      <dt className="text-label text-muted">Grace period</dt>
      <dd className="m-0">{describeGracePeriod(schedule.gracePeriodMinutes)}</dd>
      <dt className="text-label text-muted">Tap limit</dt>
      <dd className="m-0">{schedule.engagementLimit ? `${schedule.engagementLimit} taps` : 'None'}</dd>
    </dl>
  );
}
