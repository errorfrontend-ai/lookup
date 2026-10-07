import { MAXIMUM_TIME_WINDOWS_PER_SCHEDULE } from '@lookup/contracts';
import { Button } from '../../components/button';
import { Icon } from '../../components/icons';
import { SelectField } from '../../components/select-field';
import { describeDays } from '../../formatting/describe-schedule';
import { endsNextDay, isAllDay, newTimeSlot, type SlotProblems, type TimeSlot } from './schedule-draft';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const SHORT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Every quarter of an hour of the day, for choosing a start or an end. */
const TIMES_OF_DAY = Array.from({ length: 96 }, (_unused, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`);

const DAY_SHORTCUTS = [
  { label: 'Mon–Fri', days: [1, 2, 3, 4, 5] },
  { label: 'Sat–Sun', days: [6, 7] },
  { label: 'Every day', days: [1, 2, 3, 4, 5, 6, 7] },
] as const;

function TimeSelect({ label, value, onChange, error }: { label: string; value: string; onChange: (time: string) => void; error?: string }) {
  // A time that is not on the quarter hour (read from a saved schedule) is still offered, so it is never silently changed.
  const options = TIMES_OF_DAY.includes(value) ? TIMES_OF_DAY : [...TIMES_OF_DAY, value].sort();
  return (
    <SelectField label={label} value={value} onChange={(event) => onChange(event.target.value)} error={error}>
      {options.map((time) => (
        <option key={time} value={time}>
          {time}
        </option>
      ))}
    </SelectField>
  );
}

function TimeSlotRow({ slot, number, problems, onChange, onRemove }: { slot: TimeSlot; number: number; problems: SlotProblems; onChange: (changes: Partial<TimeSlot>) => void; onRemove: () => void }) {
  const toggleDay = (isoDay: number) => onChange({ days: slot.days.includes(isoDay) ? slot.days.filter((day) => day !== isoDay) : [...slot.days, isoDay] });
  const note = isAllDay(slot) ? 'All day' : endsNextDay(slot) ? 'Ends the next morning' : null;

  return (
    <li aria-label={`Time slot ${number}`} className="flex flex-col gap-4 rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-label">Time slot {number}</span>
        <button type="button" onClick={onRemove} aria-label={`Remove time slot ${number}`} className="flex size-11 items-center justify-center rounded-md border border-line bg-surface text-danger hover:bg-ground">
          <Icon name="trash" size={18} />
        </button>
      </div>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-label">Days</legend>
        <div className="flex flex-wrap gap-2">
          {SHORT_DAY_NAMES.map((shortName, index) => (
            <button
              key={shortName}
              type="button"
              aria-pressed={slot.days.includes(index + 1)}
              aria-label={DAY_NAMES[index]}
              onClick={() => toggleDay(index + 1)}
              className={`min-h-11 min-w-12 rounded-md border px-3 text-label ${slot.days.includes(index + 1) ? 'border-ink bg-ink text-surface' : 'border-line bg-surface text-ink'}`}
            >
              {shortName}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {DAY_SHORTCUTS.map((shortcut) => (
            <button key={shortcut.label} type="button" onClick={() => onChange({ days: [...shortcut.days] })} aria-label={`Choose ${shortcut.label}`} className="min-h-9 text-caption text-accent underline underline-offset-4">
              {shortcut.label}
            </button>
          ))}
        </div>
        {problems.days ? (
          <span role="alert" className="text-caption font-bold text-danger">
            {problems.days}
          </span>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <TimeSelect label="From" value={slot.from} onChange={(from) => onChange({ from })} />
        <TimeSelect label="To" value={slot.to} onChange={(to) => onChange({ to })} error={problems.end} />
      </div>
      <p className="text-caption text-muted">
        {describeDays(slot.days)} · {slot.from}–{slot.to}
        {note ? ` · ${note}` : ''}
      </p>
    </li>
  );
}

/**
 * The times as a list: each row has some days and a start and an end, to the quarter hour. It can say
 * anything the hour grid can and more (a slot from 07:30 to 08:45), and it is the only way to choose
 * times on a phone. A slot that ends before it starts runs into the next morning; "00:00 to 00:00" is all day.
 */
export function TimeSlotList({ slots, onChange, problems }: { slots: TimeSlot[]; onChange: (slots: TimeSlot[]) => void; problems: ReadonlyMap<string, SlotProblems> }) {
  return (
    <div className="flex flex-col gap-3">
      {slots.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {slots.map((slot, index) => (
            <TimeSlotRow
              key={slot.key}
              slot={slot}
              number={index + 1}
              problems={problems.get(slot.key) ?? {}}
              onChange={(changes) => onChange(slots.map((candidate) => (candidate.key === slot.key ? { ...candidate, ...changes } : candidate)))}
              onRemove={() => onChange(slots.filter((candidate) => candidate.key !== slot.key))}
            />
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-body text-muted">No times yet. Add the first one: the days, and when it starts and ends.</p>
      )}
      <Button variant="secondary" className="self-start" disabled={slots.length >= MAXIMUM_TIME_WINDOWS_PER_SCHEDULE} onClick={() => onChange([...slots, newTimeSlot()])}>
        <Icon name="plus" size={18} />
        {slots.length === 0 ? 'Add a time' : 'Add another time'}
      </Button>
    </div>
  );
}
