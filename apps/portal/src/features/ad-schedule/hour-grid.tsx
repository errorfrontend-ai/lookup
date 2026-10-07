import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { emptyGrid, type WeekGrid } from './schedule-conversion';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const SHORT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

const twoDigits = (hour: number) => String(hour).padStart(2, '0');
const hourRange = (hour: number) => `${twoDigits(hour)}:00 to ${twoDigits((hour + 1) % 24)}:00`;

/**
 * The week as a grid of hours, a row for each day. Press an hour to switch it on or off, or press and
 * drag to paint several; press a day's name to switch its whole day, or an hour's number to switch that
 * hour on every day. Each hour is a button with its day and time as its name, and the arrow keys move
 * between them, so it works without a mouse.
 */
export function HourGrid({ grid, onChange }: { grid: WeekGrid; onChange: (grid: WeekGrid) => void }) {
  const latestGrid = useRef(grid);
  latestGrid.current = grid;
  const painting = useRef<boolean | null>(null);
  const cellButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedCell, setFocusedCell] = useState({ dayIndex: 0, hour: 7 });

  useEffect(() => {
    const stopPainting = () => {
      painting.current = null;
    };
    window.addEventListener('pointerup', stopPainting);
    window.addEventListener('pointercancel', stopPainting);
    return () => {
      window.removeEventListener('pointerup', stopPainting);
      window.removeEventListener('pointercancel', stopPainting);
    };
  }, []);

  const change = (apply: (next: WeekGrid) => void) => {
    const next = latestGrid.current.map((day) => [...day]);
    apply(next);
    latestGrid.current = next;
    onChange(next);
  };
  const setCell = (dayIndex: number, hour: number, isOn: boolean) => {
    if (latestGrid.current[dayIndex]?.[hour] === isOn) return;
    change((next) => {
      (next[dayIndex] as boolean[])[hour] = isOn;
    });
  };
  const toggleDay = (dayIndex: number) => {
    const isFull = (latestGrid.current[dayIndex] as boolean[]).every(Boolean);
    change((next) => {
      next[dayIndex] = HOURS.map(() => !isFull);
    });
  };
  const toggleHour = (hour: number) => {
    const isFull = latestGrid.current.every((day) => day[hour]);
    change((next) => {
      for (const day of next) day[hour] = !isFull;
    });
  };

  const cellFrom = (target: EventTarget): { dayIndex: number; hour: number } | null => {
    const element = (target as Element).closest?.('[data-hour]');
    if (!element) return null;
    return { dayIndex: Number(element.getAttribute('data-day')), hour: Number(element.getAttribute('data-hour')) };
  };

  const startPainting = (event: PointerEvent) => {
    const cell = cellFrom(event.target);
    if (!cell || event.button > 0) return;
    // A finger keeps the element it first touched; let go of it so the cells it is dragged over get events too.
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    painting.current = !(latestGrid.current[cell.dayIndex] as boolean[])[cell.hour];
    setCell(cell.dayIndex, cell.hour, painting.current);
    setFocusedCell(cell);
  };
  const keepPainting = (event: PointerEvent) => {
    const cell = cellFrom(event.target);
    if (cell && painting.current !== null) setCell(cell.dayIndex, cell.hour, painting.current);
  };

  const moveFocus = (event: KeyboardEvent, dayIndex: number, hour: number) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    let target: { dayIndex: number; hour: number } | null = null;
    if (step[event.key]) target = { dayIndex: Math.min(6, Math.max(0, dayIndex + (step[event.key] as [number, number])[0])), hour: Math.min(23, Math.max(0, hour + (step[event.key] as [number, number])[1])) };
    else if (event.key === 'Home') target = { dayIndex, hour: 0 };
    else if (event.key === 'End') target = { dayIndex, hour: 23 };
    if (!target) return;
    event.preventDefault();
    setFocusedCell(target);
    cellButtons.current.get(`${target.dayIndex}:${target.hour}`)?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] select-none border-separate border-spacing-0.5 text-caption" onPointerDown={startPainting} onPointerOver={keepPainting} style={{ touchAction: 'pan-y' }}>
          <caption className="sr-only">Hours this ad airs, for each day of the week. Press an hour to switch it on or off.</caption>
          <thead>
            <tr>
              <td className="w-12" />
              {HOURS.map((hour) => (
                <th key={hour} scope="col" className="p-0 font-normal">
                  <button type="button" onClick={() => toggleHour(hour)} aria-label={`Switch ${hourRange(hour)} on or off for every day`} className="h-6 w-full rounded-sm text-muted tabular-nums hover:bg-ground">
                    {twoDigits(hour)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_NAMES.map((dayName, dayIndex) => (
              <tr key={dayName}>
                <th scope="row" className="p-0 text-left font-normal">
                  <button type="button" onClick={() => toggleDay(dayIndex)} aria-label={`Switch all of ${dayName} on or off`} className="h-7 w-full rounded-sm px-1 text-left text-label hover:bg-ground">
                    {SHORT_DAY_NAMES[dayIndex]}
                  </button>
                </th>
                {HOURS.map((hour) => {
                  const isOn = (grid[dayIndex] as boolean[])[hour] === true;
                  const isFocusTarget = focusedCell.dayIndex === dayIndex && focusedCell.hour === hour;
                  return (
                    <td key={hour} className="p-0">
                      <button
                        type="button"
                        ref={(element) => {
                          if (element) cellButtons.current.set(`${dayIndex}:${hour}`, element);
                          else cellButtons.current.delete(`${dayIndex}:${hour}`);
                        }}
                        data-day={dayIndex}
                        data-hour={hour}
                        aria-pressed={isOn}
                        aria-label={`${dayName} ${hourRange(hour)}`}
                        tabIndex={isFocusTarget ? 0 : -1}
                        onFocus={() => setFocusedCell({ dayIndex, hour })}
                        onKeyDown={(event) => moveFocus(event, dayIndex, hour)}
                        // A press with the mouse or a finger is handled when it starts (so it can become a drag);
                        // a click with no pointer (Enter or Space) is handled here.
                        onClick={(event) => {
                          if (event.detail === 0) setCell(dayIndex, hour, !isOn);
                        }}
                        className={`h-7 w-full rounded-sm border ${isOn ? 'border-accent bg-accent' : 'border-line-soft bg-surface hover:bg-ground'}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-muted">Press and drag to switch hours on. Press a day or an hour number to switch the whole row or column.</p>
        <Button variant="quiet" onClick={() => onChange(emptyGrid())}>
          Clear all hours
        </Button>
      </div>
    </div>
  );
}
