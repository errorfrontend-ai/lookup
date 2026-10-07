import { GRACE_PERIOD_MINUTES_OPTIONS, MAXIMUM_ENGAGEMENT_LIMIT, MAXIMUM_TIME_WINDOWS_PER_SCHEDULE } from '@lookup/contracts';
import { useMemo, useState } from 'react';
import { ProgrammeRundown } from '../../components/programme-rundown';
import { SelectField } from '../../components/select-field';
import { TextField } from '../../components/text-field';
import { useMediaQuery, WIDE_SCREEN_QUERY } from '../../components/use-media-query';
import { describeTimeWindow, formatDateRange, hoursOnAirPerWeek } from '../../formatting/describe-schedule';
import { describeGraceOption } from '../../plain-words/schedule-words';
import { HourGrid } from './hour-grid';
import { gridFromWindows, windowsFromGrid, type WeekGrid } from './schedule-conversion';
import { addDays, isRealDate, type ScheduleDraft, type ScheduleProblems, slotsFromWindows, type ScheduleValidation } from './schedule-draft';
import { TimeSlotList } from './time-slot-list';

function Problem({ children }: { children: string | undefined }) {
  return children ? (
    <p role="alert" className="text-body font-bold text-danger">
      {children}
    </p>
  ) : null;
}

function describeDuration(startsOn: string, endsOn: string): string | null {
  if (!isRealDate(startsOn) || !isRealDate(endsOn) || endsOn < startsOn) return null;
  const days = Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1;
  const weeks = days % 7 === 0 ? ` (${days / 7} ${days === 7 ? 'week' : 'weeks'})` : '';
  return `Airs for ${days === 1 ? '1 day' : `${days} days`}${weeks}`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-lg border border-line-soft bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading">{title}</h2>
        {hint ? <p className="text-caption text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The schedule step: the dates, the times (an hour grid on a wide screen, a list of times anywhere),
 * how long after a slot ends listeners still count, and an optional tap limit; and, beside them, the
 * week as it will air. Everything is in the station's time.
 */
export function ScheduleStep({
  draft,
  onChange,
  validation,
  apiProblems,
  showAllProblems,
  timeZone,
  today,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  validation: ScheduleValidation;
  apiProblems: ScheduleProblems;
  showAllProblems: boolean;
  timeZone: string;
  /** Today's date in the station's time zone. */
  today: string;
}) {
  const isWideScreen = useMediaQuery(WIDE_SCREEN_QUERY);
  const [preferredView, setPreferredView] = useState<'grid' | 'list' | null>(null);

  const { windows } = validation;
  // Worked out once per change of the times, not on every redraw: it walks every minute of the week.
  const onTheHour = useMemo(() => gridFromWindows(windows), [windows]);
  // The grid can show the times only when it shows them exactly, and every slot is complete (a slot with no days would vanish from it).
  const canUseGrid = isWideScreen && onTheHour.isOnTheHour && validation.problems.slots.size === 0;
  const view = canUseGrid ? (preferredView ?? 'grid') : 'list';

  const slotProblems = new Map([...validation.problems.slots, ...apiProblems.slots]);
  const startsOnProblem = apiProblems.startsOn ?? validation.problems.startsOn;
  const endsOnProblem = apiProblems.endsOn ?? validation.problems.endsOn;
  const timesProblem = apiProblems.times ?? (showAllProblems || windows.length > MAXIMUM_TIME_WINDOWS_PER_SCHEDULE ? validation.problems.times : undefined);
  const tapLimitProblem = apiProblems.tapLimit ?? (showAllProblems || draft.tapLimitText !== '' ? validation.problems.tapLimit : undefined);
  const duration = describeDuration(draft.startsOn, draft.endsOn);
  const hoursPerWeek = hoursOnAirPerWeek(windows);

  const paint = (grid: WeekGrid) => onChange({ ...draft, slots: slotsFromWindows(windowsFromGrid(grid)) });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-display">Set when it airs</h1>
        <p className="text-body text-muted">Listeners get this ad's buttons when they identify it during these days and hours. Everything is in station time{timeZone ? ` (${timeZone})` : ''}.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          <Section title="Dates">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextField label="First day" type="date" value={draft.startsOn} onChange={(event) => onChange({ ...draft, startsOn: event.target.value })} error={startsOnProblem} />
              <TextField label="Last day" type="date" min={draft.startsOn || undefined} value={draft.endsOn} onChange={(event) => onChange({ ...draft, endsOn: event.target.value })} error={endsOnProblem} />
            </div>
            {duration ? <p className="text-caption text-muted">{duration}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-caption text-muted">Last day shortcuts:</span>
              {[7, 14, 28].map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-label={`${days / 7 === 1 ? '1 week' : `${days / 7} weeks`} from the first day`}
                  onClick={() => onChange({ ...draft, endsOn: addDays(isRealDate(draft.startsOn) ? draft.startsOn : today, days - 1) })}
                  className="min-h-11 rounded-md border border-line bg-surface px-3 text-label hover:bg-ground"
                >
                  {days / 7 === 1 ? '1 week' : `${days / 7} weeks`}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Times" hint="Choose the days and hours this ad airs.">
            {canUseGrid ? (
              <div role="group" aria-label="How to choose the times" className="flex self-start overflow-hidden rounded-md border border-line">
                {(['grid', 'list'] as const).map((choice) => (
                  <button key={choice} type="button" aria-pressed={view === choice} onClick={() => setPreferredView(choice)} className={`min-h-11 px-4 text-label ${view === choice ? 'bg-ink text-surface' : 'bg-surface text-ink'}`}>
                    {choice === 'grid' ? 'Hour grid' : 'List of times'}
                  </button>
                ))}
              </div>
            ) : isWideScreen && !onTheHour.isOnTheHour ? (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-caption text-warning">Some times don't start or end on the hour, so they are shown as a list. The hour grid would have to round them.</p>
            ) : null}
            {view === 'grid' && onTheHour.grid ? <HourGrid grid={onTheHour.grid} onChange={paint} /> : <TimeSlotList slots={draft.slots} onChange={(slots) => onChange({ ...draft, slots })} problems={slotProblems} />}
            <Problem>{timesProblem}</Problem>
          </Section>

          <Section title="Grace period">
            <SelectField
              label="Keep giving the buttons after a slot ends"
              hint="Listeners often hear an ad just as the slot closes. This many minutes after it, they still get the buttons."
              value={String(draft.gracePeriodMinutes)}
              onChange={(event) => onChange({ ...draft, gracePeriodMinutes: Number(event.target.value) })}
            >
              {GRACE_PERIOD_MINUTES_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {describeGraceOption(minutes)}
                </option>
              ))}
            </SelectField>
          </Section>

          <Section title="Tap limit">
            <label className="flex min-h-11 cursor-pointer items-center gap-3">
              <input type="checkbox" checked={draft.hasTapLimit} onChange={(event) => onChange({ ...draft, hasTapLimit: event.target.checked })} className="size-5 accent-[var(--color-accent)]" />
              <span className="text-body">Limit how many times the buttons can be tapped</span>
            </label>
            {draft.hasTapLimit ? (
              <TextField
                label="Number of taps"
                hint={`After this many taps, listeners no longer get this ad's buttons. Up to ${MAXIMUM_ENGAGEMENT_LIMIT.toLocaleString('en-US')}.`}
                inputMode="numeric"
                autoComplete="off"
                value={draft.tapLimitText}
                onChange={(event) => onChange({ ...draft, tapLimitText: event.target.value })}
                error={tapLimitProblem}
              />
            ) : (
              <p className="text-caption text-muted">No limit: the buttons work for as long as the ad airs.</p>
            )}
          </Section>
        </div>

        <section aria-label="The week" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5 lg:sticky lg:top-28">
          <h2 className="text-heading">The week</h2>
          <ProgrammeRundown windows={windows} />
          {windows.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-body">
              {windows.map((window) => (
                <li key={`${window.daysOfWeek.join('')}-${window.localStartTime}-${window.localEndTime}`}>{describeTimeWindow(window)}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-caption text-muted">
            {hoursPerWeek === 1 ? '1 hour a week' : `${hoursPerWeek} hours a week`}
            {isRealDate(draft.startsOn) && isRealDate(draft.endsOn) && draft.endsOn >= draft.startsOn ? ` · ${formatDateRange(draft.startsOn, draft.endsOn)}` : ''}
          </p>
        </section>
      </div>
    </div>
  );
}
