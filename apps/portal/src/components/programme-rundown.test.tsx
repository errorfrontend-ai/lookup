import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgrammeRundown } from './programme-rundown';

/** The filled (on air) squares of the grid, as [hour, day] pairs, read from the picture. */
function filledCells(container: HTMLElement): Array<[string, string]> {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const rows = [...container.querySelectorAll('[role="img"] > div')].slice(1);
  return rows.flatMap((row) => {
    const [label, ...cells] = [...row.children];
    return cells.flatMap((cell, dayIndex) => (cell.classList.contains('bg-accent') ? [[label?.textContent as string, days[dayIndex] as string] as [string, string]] : []));
  });
}

describe('ProgrammeRundown', () => {
  it('fills the hours on air for each day, with one spare hour either side', () => {
    const { container } = render(<ProgrammeRundown windows={[{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }]} />);
    expect(filledCells(container)).toEqual(
      ['07:00', '08:00'].flatMap((hour) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day) => [hour, day] as [string, string])),
    );
    const hourLabels = [...container.querySelectorAll('[role="img"] > div')].slice(1).map((row) => row.firstElementChild?.textContent);
    expect(hourLabels).toEqual(['06:00', '07:00', '08:00', '09:00']);
  });

  it('carries a one-line summary for screen readers, including the hours per week', () => {
    render(<ProgrammeRundown windows={[{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }]} />);
    expect(screen.getByRole('img', { name: 'Weekly schedule: on air 10 hours a week, Mon–Fri.' })).toBeInTheDocument();
  });

  it('puts the early hours of a window that runs past midnight on the next day', () => {
    const { container } = render(<ProgrammeRundown windows={[{ daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' }]} />);
    const filled = filledCells(container);
    expect(filled).toContainEqual(['22:00', 'Fri']);
    expect(filled).toContainEqual(['23:00', 'Fri']);
    expect(filled).toContainEqual(['00:00', 'Sat']);
    expect(filled).toContainEqual(['01:00', 'Sat']);
    expect(filled).not.toContainEqual(['00:00', 'Fri']);
  });

  it('wraps from Sunday night to Monday morning', () => {
    const { container } = render(<ProgrammeRundown windows={[{ daysOfWeek: [7], localStartTime: '23:00', localEndTime: '01:00' }]} />);
    expect(filledCells(container)).toEqual(expect.arrayContaining([['23:00', 'Sun'], ['00:00', 'Mon']]));
  });

  it('says so when there are no hours', () => {
    render(<ProgrammeRundown windows={[]} />);
    expect(screen.getByText('No hours set.')).toBeInTheDocument();
  });
});
