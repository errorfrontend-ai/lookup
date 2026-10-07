import type { AdDetail, ScheduleInput } from '@lookup/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adDetail, campaignSummary, overviewFor, scheduleFixture } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setScreenWidth } from '../../test/screen-size';
import { clearAllUploads } from '../new-ad/ad-upload-store';

const person = userEvent.setup({ delay: null });
/** A field by the end of its name: fields in a row are named after the row first ("Button 2 Phone number"). */
const endsWith = (name: string) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;

beforeEach(() => {
  // "Today" is the 6th of October, 10:00 in Lusaka. Only the clock is faked, so waiting and typing work as normal.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T08:00:00Z'));
  setScreenWidth(1280);
});

afterEach(() => {
  vi.useRealTimers();
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function adWithoutSchedule(overrides: Partial<AdDetail> = {}): AdDetail {
  return adDetail({ title: 'Summer service offer', status: 'PROCESSING', schedule: null, campaign: null, ...overrides });
}

interface PageOptions {
  ad?: AdDetail;
  user?: ReturnType<typeof signedInUserWith>;
  timeZone?: string;
  /** What the API answers to saving the schedule. Defaults to saving it and returning the updated ad. */
  onSave?: (schedule: unknown) => Response;
}

/** The fake API for the schedule step of one ad. Saving puts the schedule on the ad, as the real API does. */
function installSchedulePage({ ad = adWithoutSchedule(), user = owner, timeZone = 'Africa/Lusaka', onSave }: PageOptions = {}) {
  let current = ad;
  const savedSchedules: ScheduleInput[] = [];
  const fakeApi = installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, timeZone }),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
    [`GET /stations/${stationId}/ads/${ad.id}`]: () => jsonResponse(200, current),
    [`GET /stations/${stationId}/ads/${ad.id}/history`]: () => jsonResponse(200, { events: [], nextCursor: null }),
    [`PUT /stations/${stationId}/ads/${ad.id}/schedule`]: (body) => {
      savedSchedules.push(body as ScheduleInput);
      if (onSave) return onSave(body);
      const input = body as ScheduleInput;
      current = {
        ...current,
        campaign: campaignSummary({ displayStatus: current.campaign?.displayStatus ?? 'DRAFT', startsOn: input.startsOn, endsOn: input.endsOn, timeWindows: input.timeWindows }),
        schedule: scheduleFixture({ displayStatus: current.campaign?.displayStatus ?? 'DRAFT', startsOn: input.startsOn, endsOn: input.endsOn, timeWindows: input.timeWindows, gracePeriodMinutes: input.gracePeriodMinutes, engagementLimit: input.engagementLimit }),
      };
      return jsonResponse(200, current);
    },
  });
  return { ...fakeApi, ad, savedSchedules, stepPath: `/stations/${stationId}/ads/${ad.id}/setup?step=schedule` };
}

// By label rather than by role: there are 168 of them, and asking for a role by name over that many is slow.
const cell = (day: string, hour: number) => screen.getByLabelText(`${day} ${String(hour).padStart(2, '0')}:00 to ${String((hour + 1) % 24).padStart(2, '0')}:00`);
const week = () => screen.getByRole('region', { name: 'The week' });
const dateBox = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const setDate = (label: string, value: string) => fireEvent.change(dateBox(label), { target: { value } });
const openStep = async (options: PageOptions = {}) => {
  const page = installSchedulePage(options);
  const rendered = renderPortalAt(page.stepPath);
  await screen.findByRole('heading', { level: 1, name: 'Set when it airs' });
  return { ...page, ...rendered };
};
const slotRow = (number: number) => screen.getByRole('listitem', { name: `Time slot ${number}` });

describe('The schedule step', () => {
  describe('starting a new schedule', () => {
    it('starts today for four weeks, in the station\'s time, with ten minutes of grace and no tap limit', async () => {
      await openStep();
      expect(screen.getByText('Step 4 of 5 · Schedule')).toBeInTheDocument();
      expect(screen.getByText(/Everything is in station time \(Africa\/Lusaka\)/)).toBeInTheDocument();
      expect(dateBox('First day')).toHaveValue('2026-10-06');
      expect(dateBox('Last day')).toHaveValue('2026-11-02');
      expect(screen.getByText('Airs for 28 days (4 weeks)')).toBeInTheDocument();
      expect(screen.getByLabelText(endsWith('Keep giving the buttons after a slot ends'))).toHaveValue('10');
      expect(screen.getByRole('checkbox', { name: /Limit how many times/ })).not.toBeChecked();
      expect(within(week()).getByText('No hours set.')).toBeInTheDocument();
    });

    it('takes today from the station, which can be a day ahead of where the computer is', async () => {
      vi.setSystemTime(new Date('2026-10-06T22:30:00Z'));
      await openStep();
      expect(dateBox('First day')).toHaveValue('2026-10-07');
      expect(dateBox('Last day')).toHaveValue('2026-11-03');
    });

    it('counts the quick lengths from today when the first day was emptied', async () => {
      await openStep();
      setDate('First day', '');
      await person.click(screen.getByRole('button', { name: '1 week from the first day' }));
      expect(dateBox('Last day')).toHaveValue('2026-10-12');
    });

    it('offers the quick lengths from the first day', async () => {
      await openStep();
      await person.click(screen.getByRole('button', { name: '2 weeks from the first day' }));
      expect(dateBox('Last day')).toHaveValue('2026-10-19');
      expect(screen.getByText('Airs for 14 days (2 weeks)')).toBeInTheDocument();
      await person.click(screen.getByRole('button', { name: '1 week from the first day' }));
      expect(dateBox('Last day')).toHaveValue('2026-10-12');
    });
  });

  describe('the hour grid', () => {
    it('switches an hour on and off, and the week beside it follows', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      expect(cell('Monday', 7)).toHaveAttribute('aria-pressed', 'true');
      expect(within(week()).getByText('Mon · 07:00–08:00')).toBeInTheDocument();
      expect(within(week()).getByText(/^1 hour a week/)).toBeInTheDocument();

      await person.click(cell('Monday', 7));
      expect(cell('Monday', 7)).toHaveAttribute('aria-pressed', 'false');
      expect(within(week()).getByText('No hours set.')).toBeInTheDocument();
    });

    it('paints several hours by pressing and dragging, and stops when the press ends', async () => {
      await openStep();
      fireEvent.pointerDown(cell('Tuesday', 7), { button: 0 });
      fireEvent.pointerOver(cell('Tuesday', 8));
      fireEvent.pointerOver(cell('Tuesday', 9));
      fireEvent.pointerUp(document.body);
      fireEvent.pointerOver(cell('Tuesday', 10));

      expect(within(week()).getByText('Tue · 07:00–10:00')).toBeInTheDocument();
      expect(cell('Tuesday', 10)).toHaveAttribute('aria-pressed', 'false');
    });

    it('paints hours off when the drag starts on an hour that is on', async () => {
      await openStep();
      await person.click(cell('Friday', 8));
      await person.click(cell('Friday', 9));
      await person.click(cell('Friday', 10));
      expect(within(week()).getByText('Fri · 08:00–11:00')).toBeInTheDocument();

      fireEvent.pointerDown(cell('Friday', 10), { button: 0 });
      fireEvent.pointerOver(cell('Friday', 9));
      fireEvent.pointerUp(document.body);
      expect(within(week()).getByText('Fri · 08:00–09:00')).toBeInTheDocument();
    });

    it('switches a whole day, or one hour on every day, from the labels', async () => {
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Switch all of Saturday on or off' }));
      expect(within(week()).getByText('Sat · 00:00–12:00')).toBeInTheDocument();
      expect(within(week()).getByText('Sat · 12:00–00:00')).toBeInTheDocument();
      expect(within(week()).getByText(/^24 hours a week/)).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Switch all of Saturday on or off' }));
      expect(within(week()).getByText('No hours set.')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Switch 07:00 to 08:00 on or off for every day' }));
      expect(within(week()).getByText('Every day · 07:00–08:00')).toBeInTheDocument();
      expect(within(week()).getByText(/^7 hours a week/)).toBeInTheDocument();
    });

    it('shows a night as one slot running into the next morning', async () => {
      await openStep();
      await person.click(cell('Friday', 22));
      await person.click(cell('Friday', 23));
      await person.click(cell('Saturday', 0));
      await person.click(cell('Saturday', 1));
      expect(within(week()).getByText('Fri · 22:00–02:00')).toBeInTheDocument();
    });

    it('works with the keyboard: arrow keys move between hours, Enter switches one', async () => {
      await openStep();
      cell('Monday', 7).focus();
      await person.keyboard('{ArrowRight}');
      expect(cell('Monday', 8)).toHaveFocus();
      await person.keyboard('{ArrowDown}');
      expect(cell('Tuesday', 8)).toHaveFocus();
      await person.keyboard('{Enter}');
      expect(cell('Tuesday', 8)).toHaveAttribute('aria-pressed', 'true');
      await person.keyboard('{Home}');
      expect(cell('Tuesday', 0)).toHaveFocus();
      await person.keyboard('{End}');
      expect(cell('Tuesday', 23)).toHaveFocus();
      await person.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
      expect(cell('Monday', 23)).toHaveFocus();
    });

    it('is one stop in the tab order, not 168', async () => {
      await openStep();
      const stops = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') !== null && button.getAttribute('tabindex') === '0' && /^\w+day \d\d:00 to/.test(button.getAttribute('aria-label') ?? ''));
      expect(stops).toHaveLength(1);
    });

    it('fills a day that is only partly on when its name is pressed, and a column that is only partly on when its hour is', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'Switch all of Monday on or off' }));
      expect(within(week()).getByText('Mon · 00:00–12:00')).toBeInTheDocument();
      expect(within(week()).getByText('Mon · 12:00–00:00')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Clear all hours' }));
      await person.click(cell('Tuesday', 10));
      await person.click(screen.getByRole('button', { name: 'Switch 10:00 to 11:00 on or off for every day' }));
      expect(within(week()).getByText('Every day · 10:00–11:00')).toBeInTheDocument();
    });

    it('clears every hour at once', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      await person.click(cell('Tuesday', 9));
      await person.click(screen.getByRole('button', { name: 'Clear all hours' }));
      expect(within(week()).getByText('No hours set.')).toBeInTheDocument();
    });

    it('says when the pattern needs more separate time slots than an ad can have', async () => {
      // A saved schedule at the most: 21 separate single hours, no two the same and none touching, so no days share a slot.
      const hoursByDay: Array<[day: number, hours: number[]]> = [[1, [1, 3, 5, 7, 9, 11]], [2, [2, 4, 6, 8, 10, 12]], [3, [13, 15, 17, 19]], [4, [14, 16, 18, 20]], [5, [0]]];
      const atTheMost = hoursByDay.flatMap(([day, hours]) =>
        hours.map((hour) => ({ daysOfWeek: [day], localStartTime: `${String(hour).padStart(2, '0')}:00`, localEndTime: `${String(hour + 1).padStart(2, '0')}:00` })),
      );
      await openStep({ ad: adWithoutSchedule({ campaign: campaignSummary({ displayStatus: 'DRAFT' }), schedule: scheduleFixture({ displayStatus: 'DRAFT', timeWindows: atTheMost }) }) });
      expect(screen.queryByText(/separate time slots/)).not.toBeInTheDocument();

      // One more separate hour is one too many.
      fireEvent.click(cell('Friday', 21));
      expect(await screen.findByText('This needs 22 separate time slots, and an ad can have at most 21. Use the same hours on several days, or fewer separate hours.')).toBeInTheDocument();
    });
  });

  describe('the list of times', () => {
    it('shows what was painted as slots, and what is edited there shows in the grid', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      await person.click(cell('Monday', 8));
      await person.click(screen.getByRole('button', { name: 'List of times' }));

      const row = slotRow(1);
      expect(within(row).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(row).getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(row).getByLabelText(endsWith('From'))).toHaveValue('07:00');
      expect(within(row).getByLabelText(endsWith('To'))).toHaveValue('09:00');

      await person.selectOptions(within(row).getByLabelText(endsWith('To')), '10:00');
      await person.click(screen.getByRole('button', { name: 'Hour grid' }));
      expect(cell('Monday', 9)).toHaveAttribute('aria-pressed', 'true');
      expect(within(week()).getByText('Mon · 07:00–10:00')).toBeInTheDocument();
    });

    it('is the only way to choose times on a phone: no grid, no switch', async () => {
      setScreenWidth(375);
      await openStep();
      expect(screen.queryByRole('button', { name: 'Hour grid' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Monday 07:00 to 08:00' })).not.toBeInTheDocument();
      expect(screen.getByText(/No times yet/)).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      expect(within(slotRow(1)).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
      expect(within(week()).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
    });

    it('chooses days one at a time or from the shortcuts, and says what is chosen', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      const row = slotRow(1);

      await person.click(within(row).getByRole('button', { name: 'Choose Sat–Sun' }));
      expect(within(row).getByText('Sat, Sun · 07:00–09:00')).toBeInTheDocument();
      await person.click(within(row).getByRole('button', { name: 'Friday' }));
      expect(within(row).getByText('Fri–Sun · 07:00–09:00')).toBeInTheDocument();
      await person.click(within(row).getByRole('button', { name: 'Choose Every day' }));
      expect(within(row).getByText('Every day · 07:00–09:00')).toBeInTheDocument();
    });

    it('says in words when a slot is all day or runs into the next morning', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      const row = slotRow(1);

      await person.selectOptions(within(row).getByLabelText(endsWith('From')), '22:00');
      await person.selectOptions(within(row).getByLabelText(endsWith('To')), '02:00');
      expect(within(row).getByText(/Ends the next morning/)).toBeInTheDocument();
      expect(within(week()).getByText('Mon–Fri · 22:00–02:00')).toBeInTheDocument();

      await person.selectOptions(within(row).getByLabelText(endsWith('From')), '00:00');
      await person.selectOptions(within(row).getByLabelText(endsWith('To')), '00:00');
      expect(within(row).getByText(/All day/)).toBeInTheDocument();
      expect(within(row).queryByText(/can't be the same/)).not.toBeInTheDocument();
    });

    it('says what is wrong with a slot as soon as it is wrong', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      const row = slotRow(1);

      await person.selectOptions(within(row).getByLabelText(endsWith('To')), '07:00');
      expect(within(row).getByText("The end can't be the same as the start. To air all day, choose 00:00 to 00:00.")).toBeInTheDocument();

      await person.selectOptions(within(row).getByLabelText(endsWith('To')), '09:00');
      for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await person.click(within(row).getByRole('button', { name: day }));
      expect(within(row).getByText('Choose at least one day.')).toBeInTheDocument();
    });

    it('adds and removes slots, up to the most an ad can have', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      await person.click(screen.getByRole('button', { name: 'Add another time' }));
      expect(screen.getAllByRole('listitem', { name: /^Time slot \d$/ })).toHaveLength(2);

      await person.click(screen.getByRole('button', { name: 'Remove time slot 1' }));
      expect(screen.getAllByRole('listitem', { name: /^Time slot \d$/ })).toHaveLength(1);
    });

    it('allows no more slots than an ad can have', async () => {
      setScreenWidth(375);
      // A saved schedule one short of the most (20 different half hours on Monday and Tuesday), so the list is drawn once.
      const twentyWindows = Array.from({ length: 20 }, (_unused, index) => ({
        daysOfWeek: [(index % 2) + 1],
        localStartTime: `${String(index).padStart(2, '0')}:00`,
        localEndTime: `${String(index).padStart(2, '0')}:30`,
      }));
      await openStep({ ad: adWithoutSchedule({ campaign: campaignSummary({ displayStatus: 'DRAFT' }), schedule: scheduleFixture({ displayStatus: 'DRAFT', timeWindows: twentyWindows }) }) });
      const addAnother = screen.getByRole('button', { name: 'Add another time' });
      expect(addAnother).toBeEnabled();
      fireEvent.click(addAnother);
      expect(screen.getAllByRole('listitem', { name: /^Time slot \d+$/ })).toHaveLength(21);
      expect(addAnother).toBeDisabled();
    });

    it('names the times and days after their slot, so a screen reader can tell the slots apart', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      await person.click(screen.getByRole('button', { name: 'Add another time' }));
      expect(screen.getByLabelText('Time slot 1 From')).toBeInTheDocument();
      expect(screen.getByLabelText('Time slot 2 To')).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Time slot 2 Days' })).toBeInTheDocument();
    });

    it('offers the quarter hours', async () => {
      setScreenWidth(375);
      await openStep();
      await person.click(screen.getByRole('button', { name: 'Add a time' }));
      const options = within(within(slotRow(1)).getByLabelText(endsWith('From'))).getAllByRole('option');
      expect(options).toHaveLength(96);
      expect(options[0]).toHaveValue('00:00');
      expect(options[5]).toHaveValue('01:15');
      expect(options[95]).toHaveValue('23:45');
    });
  });

  describe('times that are not on the hour', () => {
    const offTheHour = () => adWithoutSchedule({ campaign: campaignSummary({ displayStatus: 'DRAFT' }), schedule: scheduleFixture({ displayStatus: 'DRAFT', timeWindows: [{ daysOfWeek: [1, 3], localStartTime: '07:30', localEndTime: '08:45' }] }) });

    it('opens a saved schedule like that as a list, with the reason, and keeps the times exactly', async () => {
      await openStep({ ad: offTheHour() });
      expect(screen.getByText(/Some times don't start or end on the hour, so they are shown as a list/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Hour grid' })).not.toBeInTheDocument();
      expect(within(slotRow(1)).getByLabelText(endsWith('From'))).toHaveValue('07:30');
      expect(within(slotRow(1)).getByLabelText(endsWith('To'))).toHaveValue('08:45');
    });

    it('takes the grid away while a slot is unfinished, because a slot with no days would vanish from it', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'List of times' }));
      await person.click(within(slotRow(1)).getByRole('button', { name: 'Monday' }));
      expect(screen.queryByRole('button', { name: 'Hour grid' })).not.toBeInTheDocument();
      expect(within(slotRow(1)).getByText('Choose at least one day.')).toBeInTheDocument();

      await person.click(within(slotRow(1)).getByRole('button', { name: 'Choose Mon–Fri' }));
      expect(screen.getByRole('button', { name: 'Hour grid' })).toBeInTheDocument();
    });

    it('takes the grid away when a time off the hour is chosen, and brings it back when it is on the hour again', async () => {
      await openStep();
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'List of times' }));
      await person.selectOptions(within(slotRow(1)).getByLabelText(endsWith('From')), '07:30');
      expect(screen.queryByRole('button', { name: 'Hour grid' })).not.toBeInTheDocument();
      expect(screen.getByText(/Some times don't start or end on the hour/)).toBeInTheDocument();

      await person.selectOptions(within(slotRow(1)).getByLabelText(endsWith('From')), '07:00');
      expect(screen.getByRole('button', { name: 'Hour grid' })).toBeInTheDocument();
    });
  });

  describe('dates, grace and the tap limit', () => {
    it('will not accept a last day before the first, or one that has already passed', async () => {
      await openStep();
      setDate('Last day', '2026-10-01');
      expect(await screen.findByText("The last day can't be before the first day.")).toBeInTheDocument();
      setDate('First day', '2026-09-01');
      expect(await screen.findByText('That day has already passed. Choose today or a later day.')).toBeInTheDocument();
      setDate('Last day', '2026-10-06');
      expect(screen.queryByText(/already passed/)).not.toBeInTheDocument();
    });

    it('asks for a date when a box is emptied', async () => {
      await openStep();
      setDate('First day', '');
      expect(await screen.findByText('Choose the first day.')).toBeInTheDocument();
    });

    it('offers the four grace periods in words', async () => {
      await openStep();
      const options = within(screen.getByLabelText(endsWith('Keep giving the buttons after a slot ends'))).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual(['None: only during the slot', '5 minutes after the slot ends', '10 minutes after the slot ends', '20 minutes after the slot ends']);
    });

    it('shows the tap limit box only when the limit is on, and says what a wrong number should be', async () => {
      await openStep();
      expect(screen.queryByLabelText(endsWith('Number of taps'))).not.toBeInTheDocument();
      await person.click(screen.getByRole('checkbox', { name: /Limit how many times/ }));
      await person.type(screen.getByLabelText(endsWith('Number of taps')), 'lots');
      expect(await screen.findByText('Enter a whole number from 1 to 1,000,000.')).toBeInTheDocument();
    });
  });

  describe('saving', () => {
    it('saves exactly what was chosen, and goes back to Drafts', async () => {
      const { savedSchedules, router } = await openStep();
      await person.click(cell('Monday', 7));
      await person.click(cell('Monday', 8));
      await person.click(cell('Tuesday', 7));
      await person.click(cell('Tuesday', 8));
      await person.selectOptions(screen.getByLabelText(endsWith('Keep giving the buttons after a slot ends')), '20');
      await person.click(screen.getByRole('checkbox', { name: /Limit how many times/ }));
      await person.type(screen.getByLabelText(endsWith('Number of taps')), '1,500');
      setDate('Last day', '2026-10-31');
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      expect(savedSchedules[0]).toEqual({
        startsOn: '2026-10-06',
        endsOn: '2026-10-31',
        timeWindows: [{ daysOfWeek: [1, 2], localStartTime: '07:00', localEndTime: '09:00' }],
        gracePeriodMinutes: 20,
        engagementLimit: 1500,
      });
      await waitFor(() => expect(router.state.location.search).toBe('?view=drafts'));
      expect(await screen.findByText('Schedule saved.')).toBeInTheDocument();
    });

    it('goes on to the review after saving, with Save and continue', async () => {
      const { savedSchedules, router } = await openStep();
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'Save and continue' }));
      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      await waitFor(() => expect(router.state.location.search).toBe('?step=review'));
      expect(await screen.findByRole('heading', { level: 1, name: 'Review and publish' })).toBeInTheDocument();
    });

    it('does not go on while there are problems', async () => {
      const { router, calls } = await openStep();
      await person.click(screen.getByRole('button', { name: 'Save and continue' }));
      expect(await screen.findByText('Choose when this ad airs: at least one day and a time.')).toBeInTheDocument();
      expect(router.state.location.search).toBe('?step=schedule');
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('splits an all-day choice in two windows, which is how the API takes it', async () => {
      const { savedSchedules } = await openStep();
      await person.click(screen.getByRole('button', { name: 'Switch all of Sunday on or off' }));
      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      expect(savedSchedules[0]?.timeWindows).toEqual([
        { daysOfWeek: [7], localStartTime: '00:00', localEndTime: '12:00' },
        { daysOfWeek: [7], localStartTime: '12:00', localEndTime: '00:00' },
      ]);
    });

    it('shows every problem after a failed save, takes the person to the first, and sends nothing', async () => {
      const { calls } = await openStep();
      setDate('Last day', '2026-10-01');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      expect(await screen.findByText('2 things to fix before this schedule can be saved.')).toBeInTheDocument();
      expect(screen.getByText('Choose when this ad airs: at least one day and a time.')).toBeInTheDocument();
      await waitFor(() => expect(dateBox('Last day')).toHaveFocus());
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
    });

    it('reports the API\'s problems against the right boxes, in the same words, until something changes', async () => {
      await openStep({
        onSave: () =>
          errorResponse(400, 'VALIDATION_FAILED', 'Please check the details.', 'ref-3322', [
            { path: 'endsOn', code: 'end_before_start' },
            { path: 'engagementLimit', code: 'too_big' },
          ]),
      });
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      expect(await screen.findByText("The last day can't be before the first day.")).toBeInTheDocument();
      const notice = screen.getByText("We couldn't save the schedule").closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-3322');

      await person.click(cell('Monday', 8));
      expect(screen.queryByText("The last day can't be before the first day.")).not.toBeInTheDocument();
      expect(screen.queryByText("We couldn't save the schedule")).not.toBeInTheDocument();
    });

    it('says a server failure in plain words with the reference, and keeps what was chosen', async () => {
      await openStep({ onSave: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-6677') });
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      const notice = (await screen.findByText("We couldn't save the schedule")).closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-6677');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
      expect(cell('Monday', 7)).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
    });

    it('tells the person when the station\'s details could not be loaded, since today comes from them', async () => {
      const page = installSchedulePage();
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}`]: () => errorResponse(500, 'INTERNAL', 'Something went wrong.', 'ref-1111'),
        [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
        [`GET /stations/${stationId}/ads/${page.ad.id}`]: () => jsonResponse(200, page.ad),
      });
      renderPortalAt(page.stepPath);
      expect(await screen.findByText("We couldn't load your station's details")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
  });

  describe('a schedule that is already saved', () => {
    const published = () =>
      adWithoutSchedule({
        campaign: campaignSummary({ displayStatus: 'LIVE_NOW', startsOn: '2026-10-01', endsOn: '2026-10-31' }),
        schedule: scheduleFixture({ displayStatus: 'LIVE_NOW', startsOn: '2026-10-01', endsOn: '2026-10-31', gracePeriodMinutes: 5, engagementLimit: 250 }),
      });

    it('starts from what is saved, and is called editing when the ad is published', async () => {
      await openStep({ ad: published() });
      expect(screen.getByText('Edit ad · Brand A')).toBeInTheDocument();
      expect(dateBox('First day')).toHaveValue('2026-10-01');
      expect(dateBox('Last day')).toHaveValue('2026-10-31');
      expect(screen.getByLabelText(endsWith('Keep giving the buttons after a slot ends'))).toHaveValue('5');
      expect(screen.getByLabelText(endsWith('Number of taps'))).toHaveValue('250');
      expect(cell('Wednesday', 7)).toHaveAttribute('aria-pressed', 'true');
      expect(cell('Wednesday', 9)).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByText('Draft saved')).toBeInTheDocument();
    });

    it('does not ask the API to save when nothing changed', async () => {
      const ad = published();
      const { calls, router } = await openStep({ ad });
      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/${ad.id}`));
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('saves a change and returns to the ad\'s schedule', async () => {
      const ad = published();
      const { savedSchedules, router } = await openStep({ ad });
      await person.click(cell('Wednesday', 9));
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      expect(savedSchedules[0]).toMatchObject({ startsOn: '2026-10-01', endsOn: '2026-10-31', gracePeriodMinutes: 5, engagementLimit: 250 });
      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/${ad.id}`));
      expect(router.state.location.search).toBe('?tab=schedule');
      expect(await screen.findByText('Schedule saved.')).toBeInTheDocument();
    });

    it('offers no Save and continue for a published ad: there is nothing left to publish', async () => {
      await openStep({ ad: published() });
      expect(screen.queryByRole('button', { name: 'Save and continue' })).not.toBeInTheDocument();
    });

    it('takes an ended ad given new dates on to the review, because that makes a new draft that must be published', async () => {
      const ended = adWithoutSchedule({
        campaign: campaignSummary({ displayStatus: 'ENDED', startsOn: '2026-08-01', endsOn: '2026-08-31' }),
        schedule: scheduleFixture({ displayStatus: 'ENDED', startsOn: '2026-08-01', endsOn: '2026-08-31' }),
      });
      const { router, savedSchedules } = await openStep({
        ad: ended,
        onSave: (body) => {
          const input = body as ScheduleInput;
          return jsonResponse(200, { ...ended, campaign: campaignSummary({ displayStatus: 'DRAFT', startsOn: input.startsOn, endsOn: input.endsOn, timeWindows: input.timeWindows }), schedule: scheduleFixture({ displayStatus: 'DRAFT', startsOn: input.startsOn, endsOn: input.endsOn, timeWindows: input.timeWindows }) });
        },
      });
      setDate('First day', '2026-10-06');
      setDate('Last day', '2026-11-02');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      await waitFor(() => expect(router.state.location.search).toBe('?step=review'));
      expect(await screen.findByText('Schedule saved. Publish it when you are ready.')).toBeInTheDocument();
    });

    it('asks before leaving with unsaved changes', async () => {
      const { router } = await openStep({ ad: published() });
      await person.click(cell('Wednesday', 9));
      await person.click(screen.getByRole('button', { name: 'Exit' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave without saving your changes?' });
      await person.click(within(dialog).getByRole('button', { name: 'Keep working' }));
      expect(router.state.location.search).toBe('?step=schedule');
    });

    it('keeps the saved dates when the start was in the past and the schedule is only being corrected', async () => {
      const { savedSchedules } = await openStep({ ad: published() });
      await person.selectOptions(screen.getByLabelText(endsWith('Keep giving the buttons after a slot ends')), '0');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(savedSchedules).toHaveLength(1));
      expect(savedSchedules[0]?.startsOn).toBe('2026-10-01');
      expect(savedSchedules[0]?.gracePeriodMinutes).toBe(0);
    });
  });

  describe('moving around', () => {
    it('goes Back to the buttons', async () => {
      const { router } = await openStep();
      await person.click(cell('Monday', 7));
      await person.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
      expect(router.state.location.search).toBe('?step=buttons');
    });
  });
});
