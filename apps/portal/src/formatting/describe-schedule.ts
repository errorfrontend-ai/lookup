const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const FULL_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface TimeWindowLike {
  daysOfWeek: number[];
  localStartTime: string;
  localEndTime: string;
}

/** ISO days (1 = Monday … 7 = Sunday) as people say them: "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri", "Every day". */
export function describeDays(isoDays: number[]): string {
  const days = [...new Set(isoDays)].filter((day) => day >= 1 && day <= 7).sort((first, second) => first - second);
  if (days.length === 7) return 'Every day';
  if (days.length === 0) return 'No days';

  // Runs of consecutive days: three or more are written as a range, shorter runs as a list.
  const runs: number[][] = [];
  for (const day of days) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun[lastRun.length - 1] === day - 1) lastRun.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) => {
      const first = DAY_NAMES[(run[0] as number) - 1];
      const last = DAY_NAMES[(run[run.length - 1] as number) - 1];
      if (run.length >= 3) return `${first}–${last}`;
      return run.map((day) => DAY_NAMES[day - 1]).join(', ');
    })
    .join(', ');
}

export function describeFullDayName(isoDay: number): string {
  return FULL_DAY_NAMES[isoDay - 1] ?? '';
}

/** "07:00–09:00". A window that ends at or before its start runs past midnight, which the end time shows. */
export function describeTimeRange(window: Pick<TimeWindowLike, 'localStartTime' | 'localEndTime'>): string {
  return `${window.localStartTime}–${window.localEndTime}`;
}

/** One window in words: "Mon–Fri · 07:00–09:00". */
export function describeTimeWindow(window: TimeWindowLike): string {
  return `${describeDays(window.daysOfWeek)} · ${describeTimeRange(window)}`;
}

/** The whole schedule in one line for a list: the first window, and how many more there are. */
export function describeScheduleSummary(windows: TimeWindowLike[]): string {
  const [first, ...others] = windows;
  if (!first) return 'No times set';
  return others.length === 0 ? describeTimeWindow(first) : `${describeTimeWindow(first)} +${others.length} more`;
}

/** Hours on air per week, counting each hour once even if windows overlap. */
export function hoursOnAirPerWeek(windows: TimeWindowLike[]): number {
  const minutesOnAir = new Set<number>();
  for (const window of windows) {
    const start = minutesOf(window.localStartTime);
    let end = minutesOf(window.localEndTime);
    const crossesMidnight = end <= start;
    if (crossesMidnight) end += 24 * 60;
    for (const day of window.daysOfWeek) {
      for (let minute = start; minute < end; minute += 1) {
        minutesOnAir.add(((day - 1) * 24 * 60 + minute) % (7 * 24 * 60));
      }
    }
  }
  return Math.round((minutesOnAir.size / 60) * 10) / 10;
}

function minutesOf(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A station-local "YYYY-MM-DD" as people write it: "1 Oct", or "1 Oct 2026" with the year. Written out
 * here rather than by Intl, so it is identical in every browser and never shifted by a time zone.
 */
export function formatStationDate(date: string, includeYear = false): string {
  const [year = '', month = '1', day = '1'] = date.split('-');
  const text = `${Number(day)} ${MONTH_ABBREVIATIONS[Number(month) - 1] ?? ''}`;
  return includeYear ? `${text} ${year}` : text;
}

/** "1 – 31 Oct", "28 Sep – 3 Oct", or with years when they differ. A single day is just that day. */
export function formatDateRange(startsOn: string, endsOn: string): string {
  if (startsOn === endsOn) return formatStationDate(startsOn);
  const [startYear, startMonth] = startsOn.split('-');
  const [endYear, endMonth] = endsOn.split('-');
  if (startYear !== endYear) return `${formatStationDate(startsOn, true)} – ${formatStationDate(endsOn, true)}`;
  if (startMonth === endMonth) {
    const startDay = Number(startsOn.slice(8, 10));
    return `${startDay} – ${formatStationDate(endsOn)}`;
  }
  return `${formatStationDate(startsOn)} – ${formatStationDate(endsOn)}`;
}
