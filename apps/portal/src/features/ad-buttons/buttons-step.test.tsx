import type { AdDetail } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { actionCardFixture, adDetail, campaignSummary, overviewFor, scheduleFixture } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setScreenWidth } from '../../test/screen-size';
import { clearAllUploads } from '../new-ad/ad-upload-store';

const person = userEvent.setup({ delay: null });
/** A field by the end of its name: fields in a row are named after the row first ("Button 2 Phone number"). */
const endsWith = (name: string) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => setScreenWidth(1280));

afterEach(() => {
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

/** A value with its object keys in the order Postgres's jsonb keeps them: shorter names first, then alphabetical. */
function inJsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inJsonbOrder);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([first], [second]) => first.length - second.length || (first < second ? -1 : 1))
        .map(([key, entry]) => [key, inJsonbOrder(entry)]),
    );
  }
  return value;
}

/** An ad whose audio has arrived and which has no buttons yet. */
function adWithoutButtons(overrides: Partial<AdDetail> = {}): AdDetail {
  return adDetail({ title: 'Summer service offer', status: 'PROCESSING', actionCard: null, schedule: null, campaign: null, ...overrides });
}

interface PageOptions {
  ad?: AdDetail;
  user?: ReturnType<typeof signedInUserWith>;
  /** What the API answers to saving the buttons. Defaults to saving them and returning the updated ad. */
  onSave?: (card: unknown) => Response;
}

/** The fake API for the buttons step of one ad. Saving puts the card on the ad, as the real API does. */
function installButtonsPage({ ad = adWithoutButtons(), user = owner, onSave }: PageOptions = {}) {
  let current = { ...ad, actionCard: inJsonbOrder(ad.actionCard) as AdDetail['actionCard'] };
  const savedCards: unknown[] = [];
  const fakeApi = installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, timeZone: 'Africa/Lusaka' }),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
    [`GET /stations/${stationId}/ads/${ad.id}`]: () => jsonResponse(200, current),
    [`GET /stations/${stationId}/ads/${ad.id}/history`]: () => jsonResponse(200, { events: [], nextCursor: null }),
    [`PUT /stations/${stationId}/ads/${ad.id}/card`]: (body) => {
      savedCards.push(body);
      if (onSave) return onSave(body);
      current = { ...current, actionCard: inJsonbOrder(body) as AdDetail['actionCard'] };
      return jsonResponse(200, current);
    },
  });
  return { ...fakeApi, ad, savedCards, stepPath: `/stations/${stationId}/ads/${ad.id}/setup?step=buttons` };
}

const addButton = async (kind: 'Call' | 'WhatsApp' | 'Directions' | 'Website') => person.click(screen.getByRole('button', { name: `Add a ${kind} button` }));
const rowNumber = (number: number) => screen.getByRole('listitem', { name: `Button ${number}` });
const labelsInOrder = () => screen.queryAllByRole('listitem', { name: /^Button \d$/ }).map((row) => (within(row).getByLabelText(endsWith('Label')) as HTMLInputElement).value);
const typeInto = async (row: HTMLElement, field: string, text: string) => {
  const input = within(row).getByLabelText(endsWith(field));
  await person.clear(input);
  if (text) await person.type(input, text);
};
const preview = () => screen.getByRole('group', { name: /Preview of what listeners see/ });

describe('The buttons step', () => {
  describe('starting with none', () => {
    it('invites the first button, shows an empty preview, and will not save nothing', async () => {
      const { stepPath, calls } = installButtonsPage();
      renderPortalAt(stepPath);

      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
      expect(screen.getByText('Step 3 of 5 · Buttons')).toBeInTheDocument();
      expect(screen.getByText(/None yet/)).toBeInTheDocument();
      expect(screen.getByText(/Choose the first one below/)).toBeInTheDocument();
      expect(screen.getByText('Add the first button')).toBeInTheDocument();
      expect(within(preview()).getByText('No buttons yet.')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      expect(await screen.findByText('Add at least one button, or listeners will have nothing to tap.')).toBeInTheDocument();
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });
  });

  describe('adding and changing a button', () => {
    it('gives a new button a starting label and says nothing is wrong until the person leaves the field', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      await addButton('Call');
      const row = rowNumber(1);
      expect(within(row).getByLabelText(endsWith('Label'))).toHaveValue('Call us');
      expect(within(row).getByText('The main button')).toBeInTheDocument();
      expect(within(row).queryByText('Enter the phone number.')).not.toBeInTheDocument();
      // The new row has the cursor, so it can be typed into at once.
      expect(within(row).getByLabelText(endsWith('Label'))).toHaveFocus();

      await person.click(within(row).getByLabelText(endsWith('Phone number')));
      await person.tab();
      expect(await within(row).findByText('Enter the phone number.')).toBeInTheDocument();

      await person.type(within(row).getByLabelText(endsWith('Phone number')), '0977 123 456');
      expect(within(row).queryByText('Enter the phone number.')).not.toBeInTheDocument();
      expect(within(row).getByText(/Calls \+260 97 712 3456/)).toBeInTheDocument();
      expect(within(preview()).getByText('Call us')).toBeInTheDocument();
    });

    it('shows how many characters of the label are used', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      expect(within(rowNumber(1)).getByText('7 / 32')).toBeInTheDocument();
    });

    it('leaves a button with a problem out of the preview, saying which, until it is fixed', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      await addButton('Call');
      await typeInto(rowNumber(1), 'Phone number', '0977123456');
      await addButton('Website');
      const row = rowNumber(2);
      await typeInto(row, 'Web address', 'http://brand.co.zm');
      await person.tab();

      expect(await within(row).findByText(/Addresses must start with https:\/\//)).toBeInTheDocument();
      expect(within(preview()).getByText('Call us')).toBeInTheDocument();
      expect(within(preview()).queryByText('Visit our website')).not.toBeInTheDocument();
      expect(screen.getByText('Not shown until fixed: button 2.')).toBeInTheDocument();

      await typeInto(row, 'Web address', 'brand.co.zm/book');
      expect(within(preview()).getByText('Visit our website')).toBeInTheDocument();
      expect(screen.queryByText(/Not shown until fixed/)).not.toBeInTheDocument();
      expect(within(row).getByText(/Opens https:\/\/brand\.co\.zm\/book/)).toBeInTheDocument();
    });

    it('keeps a label the person wrote when the type changes, and follows the type when the label was the starting one', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      const row = rowNumber(1);

      await person.selectOptions(within(row).getByLabelText(endsWith('Type')), 'WhatsApp');
      expect(within(row).getByLabelText(endsWith('Label'))).toHaveValue('Chat on WhatsApp');
      expect(within(row).getByLabelText(endsWith('First message (optional)'))).toBeInTheDocument();

      await typeInto(row, 'Label', 'Ring Brand A');
      await person.selectOptions(within(row).getByLabelText(endsWith('Type')), 'Website');
      expect(within(row).getByLabelText(endsWith('Label'))).toHaveValue('Ring Brand A');
      expect(within(row).getByLabelText(endsWith('Web address'))).toBeInTheDocument();
      expect(within(row).queryByLabelText(endsWith('Phone number'))).not.toBeInTheDocument();
    });

    it('reads a Directions location from a pasted Google Maps link and offers a way to check it', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Directions');
      const row = rowNumber(1);

      await typeInto(row, 'Location', 'https://maps.app.goo.gl/AbCdEf');
      await person.tab();
      expect(await within(row).findByText(/That's a short Maps link/)).toBeInTheDocument();

      await typeInto(row, 'Location', 'https://www.google.com/maps/place/Cairo+Road/@-15.4166,28.2833,17z/data=!3d-15.4167!4d28.2834');
      expect(within(row).getByText(/Understood: -15.4167, 28.2834/)).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: 'Check on Google Maps' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=-15.416700%2C28.283400');
      expect(within(row).queryByText(/That's a short Maps link/)).not.toBeInTheDocument();
    });

    it('lets a WhatsApp first message run to several lines and counts it', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('WhatsApp');
      const row = rowNumber(1);
      await person.type(within(row).getByLabelText(endsWith('First message (optional)')), 'Hello{Enter}I saw your ad');
      expect(within(row).getByText('19 / 500')).toBeInTheDocument();
    });
  });

  describe('fields a screen reader can tell apart', () => {
    it('names each field after its button, so "Phone number" in button 2 is not mistaken for the one in button 1', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await addButton('WhatsApp');
      expect(screen.getByLabelText('Button 1 Phone number')).toBeInTheDocument();
      expect(screen.getByLabelText('Button 2 Phone number')).toBeInTheDocument();
      expect(screen.getByLabelText('Button 2 First message (optional)')).toBeInTheDocument();
      expect(screen.getByLabelText('Button 1 Type')).toBeInTheDocument();
      expect(screen.getByLabelText('Button 2 Label')).toBeInTheDocument();
    });

    it('marks a field with a problem as invalid and ties it to the message, which is announced', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Website');
      const field = screen.getByLabelText('Button 1 Web address');
      await person.type(field, 'http://brand.co.zm');
      await person.tab();

      const message = await screen.findByText(/Addresses must start with https:\/\//);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(message).toHaveAttribute('role', 'alert');
      expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
    });
  });

  describe('the order and the number of buttons', () => {
    it('moves a button up or down, and the first is always the main one', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await addButton('WhatsApp');
      await addButton('Website');
      expect(labelsInOrder()).toEqual(['Call us', 'Chat on WhatsApp', 'Visit our website']);
      expect(within(rowNumber(1)).getByRole('button', { name: 'Move “Call us” up' })).toBeDisabled();
      expect(within(rowNumber(3)).getByRole('button', { name: 'Move “Visit our website” down' })).toBeDisabled();

      await person.click(screen.getByRole('button', { name: 'Move “Visit our website” up' }));
      expect(labelsInOrder()).toEqual(['Call us', 'Visit our website', 'Chat on WhatsApp']);
      await person.click(screen.getByRole('button', { name: 'Move “Call us” down' }));
      expect(labelsInOrder()).toEqual(['Visit our website', 'Call us', 'Chat on WhatsApp']);
      expect(within(rowNumber(1)).getByText('The main button')).toBeInTheDocument();
    });

    it('removes a button and puts the cursor back at the top of the list', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await addButton('Website');

      await person.click(screen.getByRole('button', { name: 'Remove “Call us”' }));
      expect(labelsInOrder()).toEqual(['Visit our website']);
      expect(screen.getByRole('heading', { name: 'Buttons' })).toHaveFocus();
    });

    it('holds at most six buttons, and says so', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      for (let count = 0; count < 6; count += 1) await addButton('Call');

      expect(screen.getAllByRole('listitem', { name: /^Button \d$/ })).toHaveLength(6);
      expect(screen.getByRole('button', { name: 'Add a Call button' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add a Website button' })).toBeDisabled();
      expect(screen.getByText(/You have 6 buttons, the most a card can hold/)).toBeInTheDocument();

      await person.click(screen.getAllByRole('button', { name: 'Remove “Call us”' })[0] as HTMLElement);
      expect(screen.getByRole('button', { name: 'Add a Call button' })).toBeEnabled();
    });
  });

  describe('saving', () => {
    it('saves a card made from what was typed, with each button\'s own id, and goes back to Drafts', async () => {
      const { stepPath, savedCards } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      await addButton('Call');
      await typeInto(rowNumber(1), 'Phone number', '0977 123 456');
      await addButton('WhatsApp');
      await typeInto(rowNumber(2), 'Phone number', '+260 96 600 0111');
      await typeInto(rowNumber(2), 'First message (optional)', '  Hello, I saw your ad  ');
      await addButton('Directions');
      await typeInto(rowNumber(3), 'Location', '-15.4167, 28.2833');
      await addButton('Website');
      await typeInto(rowNumber(4), 'Web address', 'brand.co.zm/book');
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      await waitFor(() => expect(savedCards).toHaveLength(1));
      expect(savedCards[0]).toEqual({
        schema_version: 1,
        layout: 'VERTICAL_STACK',
        actions: [
          { type: 'CALL', id: expect.stringMatching(UUID), label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' },
          { type: 'WHATSAPP', id: expect.stringMatching(UUID), label: 'Chat on WhatsApp', style: 'SECONDARY', phone_number_e164: '+260966000111', prefilled_text: 'Hello, I saw your ad' },
          { type: 'MAP', id: expect.stringMatching(UUID), label: 'Get directions', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833 },
          { type: 'LINK', id: expect.stringMatching(UUID), label: 'Visit our website', style: 'OUTLINE', url: 'https://brand.co.zm/book' },
        ],
      });
      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads`));
      expect(router.state.location.search).toBe('?view=drafts');
      expect(await screen.findByText('Buttons saved. Continue setup from Drafts any time.')).toBeInTheDocument();
    });

    it('saves the buttons and goes on to the schedule with Save and continue', async () => {
      const { stepPath, savedCards } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await typeInto(rowNumber(1), 'Phone number', '0977 123 456');

      await person.click(screen.getByRole('button', { name: 'Save and continue' }));

      await waitFor(() => expect(savedCards).toHaveLength(1));
      await waitFor(() => expect(router.state.location.search).toBe('?step=schedule'));
      expect(await screen.findByRole('heading', { level: 1, name: 'Set when it airs' })).toBeInTheDocument();
      expect(screen.getByText('Step 4 of 5 · Schedule')).toBeInTheDocument();
    });

    it('goes on without asking the API when the saved buttons were not changed', async () => {
      const { stepPath, calls } = installButtonsPage({ ad: adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null }) });
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await person.click(screen.getByRole('button', { name: 'Save and continue' }));
      await waitFor(() => expect(router.state.location.search).toBe('?step=schedule'));
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('stays on the buttons when they have problems, and shows them', async () => {
      const { stepPath, calls } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await person.click(screen.getByRole('button', { name: 'Save and continue' }));
      expect(await within(rowNumber(1)).findByText('Enter the phone number.')).toBeInTheDocument();
      expect(router.state.location.search).toBe('?step=buttons');
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('shows every problem after a failed save, takes the person to the first one, and sends nothing', async () => {
      const { stepPath, calls } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');
      await addButton('Website');
      await typeInto(rowNumber(2), 'Web address', 'bit.ly/abc');

      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      expect(await screen.findByText('2 things to fix before these buttons can be saved.')).toBeInTheDocument();
      expect(within(rowNumber(1)).getByText('Enter the phone number.')).toBeInTheDocument();
      expect(within(rowNumber(2)).getByText('Short links like bit.ly hide where the button goes. Paste the full address instead.')).toBeInTheDocument();
      await waitFor(() => expect(within(rowNumber(1)).getByLabelText(endsWith('Phone number'))).toHaveFocus());
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
    });

    it('does not ask the API to save when nothing changed', async () => {
      const { stepPath, calls } = installButtonsPage({ ad: adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null }) });
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      expect(screen.getByText('Draft saved')).toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(router.state.location.search).toBe('?view=drafts'));
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('does not count tidying as a change: a number saved as +260 97 712 3456 is not different from 0977 123 456', async () => {
      const { stepPath } = installButtonsPage({ ad: adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null }) });
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await typeInto(rowNumber(1), 'Phone number', '0977123456');
      expect(screen.getByText('Draft saved')).toBeInTheDocument();
      await typeInto(rowNumber(1), 'Label', 'Phone Brand A');
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
    });

    it('reports the API\'s own problems against the right field, in the same words, until the buttons change', async () => {
      const { stepPath } = installButtonsPage({
        ad: adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null }),
        onSave: () => errorResponse(400, 'VALIDATION_FAILED', 'Please check the details.', 'ref-4455', [{ path: 'actions.0.phone_number_e164', code: 'zambian_number_must_have_nine_digits' }]),
      });
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await typeInto(rowNumber(1), 'Label', 'Phone Brand A');

      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      expect(await within(rowNumber(1)).findByText('Zambian numbers have 9 digits after +260, like 0977 123 456.')).toBeInTheDocument();
      const notice = screen.getByText("We couldn't save the buttons").closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-4455');

      await typeInto(rowNumber(1), 'Label', 'Phone Brand B');
      expect(within(rowNumber(1)).queryByText(/Zambian numbers have 9 digits/)).not.toBeInTheDocument();
      expect(screen.queryByText("We couldn't save the buttons")).not.toBeInTheDocument();
    });

    it('says a server failure in plain words with the reference, and keeps what was typed', async () => {
      const { stepPath } = installButtonsPage({
        ad: adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null }),
        onSave: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-9988'),
      });
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await typeInto(rowNumber(1), 'Label', 'Phone Brand A');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      const notice = (await screen.findByText("We couldn't save the buttons")).closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-9988');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
      expect(within(rowNumber(1)).getByLabelText(endsWith('Label'))).toHaveValue('Phone Brand A');
      expect(screen.getByText('Changes not saved yet')).toBeInTheDocument();
    });
  });

  describe('a card that is already saved', () => {
    it('starts from the saved buttons, shows them in the preview, and keeps their ids when saved again', async () => {
      const ad = adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null });
      const { stepPath, savedCards } = installButtonsPage({ ad });
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      expect(labelsInOrder()).toEqual(['Call Brand A', 'Chat on WhatsApp', 'Get directions']);
      expect(within(rowNumber(1)).getByLabelText(endsWith('Phone number'))).toHaveValue('+260 97 712 3456');
      expect(within(rowNumber(2)).getByLabelText(endsWith('First message (optional)'))).toHaveValue('Hello there');
      expect(within(rowNumber(3)).getByLabelText(endsWith('Location'))).toHaveValue('-15.4167, 28.2833');
      expect(within(rowNumber(3)).getByLabelText(endsWith('Place name (optional)'))).toHaveValue('Cairo Road, Lusaka');
      expect(within(preview()).getByText('Call Brand A')).toBeInTheDocument();
      expect(within(preview()).getByText('Brand A · via Radio Phoenix · 89.5 FM')).toBeInTheDocument();

      await typeInto(rowNumber(1), 'Label', 'Call us now');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(savedCards).toHaveLength(1));
      const ids = (savedCards[0] as { actions: Array<{ id: string; label: string }> }).actions.map((action) => action.id);
      expect(ids).toEqual(actionCardFixture().actions.map((action) => action.id));
      expect((savedCards[0] as { actions: Array<{ label: string }> }).actions[0]?.label).toBe('Call us now');
    });

    it('is called editing, not new, when the ad is already published, and returns to the ad afterwards', async () => {
      const ad = adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: campaignSummary({ displayStatus: 'LIVE_NOW' }), schedule: scheduleFixture() });
      const { stepPath } = installButtonsPage({ ad });
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      expect(screen.getByText('Edit ad · Brand A')).toBeInTheDocument();

      await typeInto(rowNumber(1), 'Label', 'Call us now');
      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/${ad.id}`));
      expect(router.state.location.search).toBe('?tab=buttons');
      expect(await screen.findByText('Buttons saved.')).toBeInTheDocument();
    });

    it('will not offer to change a card in a form this page cannot read, which could lose some of it', async () => {
      const ad = adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null, actionCard: { schema_version: 2, layout: 'VERTICAL_STACK', actions: [] } as unknown as AdDetail['actionCard'] });
      const { stepPath, calls } = installButtonsPage({ ad });
      renderPortalAt(stepPath);

      expect(await screen.findByRole('heading', { name: "These buttons can't be changed here" })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add a/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save and close' })).toBeDisabled();
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });
  });

  describe('moving around', () => {
    it('asks before leaving with unsaved changes, and can be told to keep working', async () => {
      const { stepPath } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Call');

      // With changes not saved, the exit button does not claim the draft is saved.
      expect(screen.queryByRole('button', { name: 'Exit (your draft is saved)' })).not.toBeInTheDocument();
      await person.click(screen.getByRole('button', { name: 'Exit' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave without saving your changes?' });
      expect(dialog).toHaveTextContent("The changes you made haven't been saved");
      await person.click(within(dialog).getByRole('button', { name: 'Keep working' }));
      expect(labelsInOrder()).toEqual(['Call us']);

      await person.click(screen.getByRole('button', { name: 'Exit' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }));
      await waitFor(() => expect(router.state.location.search).toBe('?view=drafts'));
    });

    it('asks before Save and close drops changes to the times that are not saved yet', async () => {
      const ad = adDetail({ title: 'Summer service offer', status: 'PROCESSING', campaign: null, schedule: null });
      const { stepPath } = installButtonsPage({ ad });
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      // Change the times without saving them, then come back to the buttons and change those too.
      await person.click(screen.getByRole('button', { name: 'Save and continue' }));
      await screen.findByRole('heading', { level: 1, name: 'Set when it airs' });
      await person.selectOptions(screen.getByLabelText('Keep giving the buttons after a slot ends'), '0');
      await person.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { level: 1, name: 'Add the buttons' });
      await typeInto(rowNumber(1), 'Label', 'Phone Brand A');

      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave without saving your changes?' });
      await person.click(within(dialog).getByRole('button', { name: 'Keep working' }));
      expect(router.state.location.search).toBe('?step=buttons');
    });

    it('leaves at once when nothing was changed', async () => {
      const { stepPath } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await person.click(screen.getByRole('button', { name: 'Exit (your draft is saved)' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search).toBe('?view=drafts'));
    });

    it('keeps what was typed when the person goes Back to the audio and returns', async () => {
      const { stepPath } = installButtonsPage();
      const { router } = renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      await addButton('Website');
      await typeInto(rowNumber(1), 'Web address', 'brand.co.zm');

      await person.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Your audio' })).toBeInTheDocument();
      expect(router.state.location.search).toBe('?step=audio');

      await person.click(screen.getByRole('button', { name: 'Next: Buttons' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
      expect(within(rowNumber(1)).getByLabelText(endsWith('Web address'))).toHaveValue('brand.co.zm');
    });

    it('will not go on from the audio until the audio is in', async () => {
      const waiting = adWithoutButtons({ status: 'AWAITING_UPLOAD', uploadedAt: null });
      installButtonsPage({ ad: waiting });
      renderPortalAt(`/stations/${stationId}/ads/${waiting.id}/setup?step=audio`);
      await screen.findByRole('heading', { level: 1, name: 'Your audio' });
      expect(screen.getByRole('button', { name: 'Next: Buttons' })).toBeDisabled();
    });
  });

  describe('on a phone', () => {
    it('shows one thing at a time, with Edit and Preview to switch, and loses nothing by switching', async () => {
      setScreenWidth(375);
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });

      const edit = screen.getByRole('button', { name: 'Edit' });
      const previewButton = screen.getByRole('button', { name: 'Preview' });
      expect(edit).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('group', { name: /Preview of what listeners see/ })).not.toBeInTheDocument();

      await addButton('Call');
      await typeInto(rowNumber(1), 'Phone number', '0977123456');
      await person.click(previewButton);
      expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      expect(within(preview()).getByText('Call us')).toBeInTheDocument();
      expect(screen.queryByRole('listitem', { name: 'Button 1' })).not.toBeInTheDocument();

      await person.click(edit);
      expect(within(rowNumber(1)).getByLabelText(endsWith('Phone number'))).toHaveValue('0977123456');
    });

    it('shows both side by side on a wide screen, with no switch', async () => {
      setScreenWidth(1280);
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
      expect(preview()).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Buttons' })).toBeInTheDocument();
    });

    it('can show the preview at the two phone widths listeners have', async () => {
      const { stepPath } = installButtonsPage();
      renderPortalAt(stepPath);
      await screen.findByRole('heading', { name: 'Add the buttons' });
      expect(screen.getByRole('heading', { name: 'What listeners see' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Preview of what listeners see, on a 320 pixel wide phone' })).toBeInTheDocument();
      const widths = screen.getByRole('group', { name: 'Preview width' });
      expect(within(widths).getByRole('button', { name: 'Small phone · 320' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(widths).getByRole('button', { name: 'Large phone · 411' })).toHaveAttribute('aria-pressed', 'false');

      await person.click(within(widths).getByRole('button', { name: 'Large phone · 411' }));
      expect(screen.getByRole('group', { name: 'Preview of what listeners see, on a 411 pixel wide phone' })).toBeInTheDocument();
      expect(within(widths).getByRole('button', { name: 'Large phone · 411' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(widths).getByRole('button', { name: 'Small phone · 320' })).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
