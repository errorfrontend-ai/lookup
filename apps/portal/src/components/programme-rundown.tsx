import { describeDays, hoursOnAirPerWeek, type TimeWindowLike } from '../formatting/describe-schedule';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Which hours of the week are on air: `hours[dayIndex][hour]`, with Monday as day 0. Whole hours that any part of a window touches. */
function hoursOnAir(windows: TimeWindowLike[]): boolean[][] {
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => false));
  const mark = (dayIndex: number, fromMinute: number, toMinute: number) => {
    for (let hour = Math.floor(fromMinute / 60); hour * 60 < toMinute && hour < 24; hour += 1) (hours[dayIndex] as boolean[])[hour] = true;
  };
  for (const window of windows) {
    const [startHour = 0, startMinute = 0] = window.localStartTime.split(':').map(Number);
    const [endHour = 0, endMinute = 0] = window.localEndTime.split(':').map(Number);
    const start = (startHour as number) * 60 + (startMinute as number);
    const end = (endHour as number) * 60 + (endMinute as number);
    for (const isoDay of window.daysOfWeek) {
      const dayIndex = isoDay - 1;
      if (end > start) {
        mark(dayIndex, start, end);
      } else {
        // Runs past midnight: the evening on its own day, the early hours on the next.
        mark(dayIndex, start, 24 * 60);
        mark((dayIndex + 1) % 7, 0, end);
      }
    }
  }
  return hours;
}

/**
 * The week as a programme rundown: a column for each day, a row for each hour that any day airs, the
 * hours on air filled in. It is a picture of the schedule, so it carries a one-line summary for screen
 * readers; the exact times are written out beside it wherever it is used.
 */
export function ProgrammeRundown({ windows }: { windows: TimeWindowLike[] }) {
  const hours = hoursOnAir(windows);
  const usedHours = Array.from({ length: 24 }, (_unused, hour) => hours.some((day) => day[hour])).map((isUsed, hour) => (isUsed ? hour : -1)).filter((hour) => hour >= 0);
  if (usedHours.length === 0) return <p className="text-body text-muted">No hours set.</p>;
  const firstHour = Math.max(0, (usedHours[0] as number) - 1);
  const lastHour = Math.min(23, (usedHours[usedHours.length - 1] as number) + 1);
  const rows = Array.from({ length: lastHour - firstHour + 1 }, (_unused, index) => firstHour + index);
  const summary = `Weekly schedule: on air ${hoursOnAirPerWeek(windows)} hours a week, ${windows.map((window) => describeDays(window.daysOfWeek)).join(' and ')}.`;

  return (
    <div role="img" aria-label={summary} className="flex flex-col gap-0.5 text-caption text-muted">
      <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-0.5 text-center">
        <span />
        {DAY_LABELS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      {rows.map((hour) => (
        <div key={hour} className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] items-center gap-0.5">
          <span className="tabular-nums">{String(hour).padStart(2, '0')}:00</span>
          {DAY_LABELS.map((day, dayIndex) => (
            <span key={day} className={`h-4 rounded-sm ${(hours[dayIndex] as boolean[])[hour] ? 'bg-accent' : 'bg-line-soft'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
