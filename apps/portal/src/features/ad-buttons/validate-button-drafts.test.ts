import { ActionCard } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { type ButtonDraft, newButtonDraft } from './button-draft';
import { describeHiddenButtons } from '../../plain-words/button-words';
import { problemsFromApiFields, validateButtonDrafts } from './validate-button-drafts';

function draft(kind: ButtonDraft['kind'], fields: Partial<ButtonDraft> = {}): ButtonDraft {
  return { ...newButtonDraft(kind), ...fields };
}

const goodCall = (fields: Partial<ButtonDraft> = {}) => draft('CALL', { label: 'Call us', phoneText: '0977 123 456', ...fields });
const goodWhatsApp = (fields: Partial<ButtonDraft> = {}) => draft('WHATSAPP', { label: 'Chat with us', phoneText: '+260 96 600 0111', firstMessage: 'Hello, I saw your ad', ...fields });
const goodMap = (fields: Partial<ButtonDraft> = {}) => draft('MAP', { label: 'Find us', locationText: '-15.4167, 28.2833', placeName: 'Cairo Road', ...fields });
const goodLink = (fields: Partial<ButtonDraft> = {}) => draft('LINK', { label: 'Book online', webAddressText: 'brand.co.zm/book', ...fields });

describe('turning typed buttons into a card', () => {
  describe('a good set of buttons', () => {
    it('makes a card from what was typed: numbers, links and places tidied, labels trimmed, optional parts left out when empty', () => {
      const drafts = [goodCall({ label: '  Call us  ' }), goodWhatsApp({ firstMessage: '   ' }), goodMap({ placeName: '' }), goodLink()];
      const validation = validateButtonDrafts(drafts);

      expect(validation.cardProblem).toBeNull();
      expect(validation.problemCount).toBe(0);
      expect(validation.card).toEqual({
        schema_version: 1,
        layout: 'VERTICAL_STACK',
        actions: [
          { type: 'CALL', id: drafts[0]?.key, label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' },
          { type: 'WHATSAPP', id: drafts[1]?.key, label: 'Chat with us', style: 'SECONDARY', phone_number_e164: '+260966000111' },
          { type: 'MAP', id: drafts[2]?.key, label: 'Find us', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833 },
          { type: 'LINK', id: drafts[3]?.key, label: 'Book online', style: 'OUTLINE', url: 'https://brand.co.zm/book' },
        ],
      });
    });

    it('only ever makes a card that the contracts accept, which is what the API and the app accept', () => {
      const validation = validateButtonDrafts([goodCall(), goodWhatsApp(), goodMap(), goodLink({ webAddressText: 'bücher.co.zm' })]);
      expect(ActionCard.safeParse(validation.card).success).toBe(true);
    });

    it('keeps the first message and place name when they are given', () => {
      const validation = validateButtonDrafts([goodWhatsApp({ firstMessage: '  Hello  ' }), goodMap({ placeName: ' Cairo Road ' })]);
      expect(validation.card?.actions[0]).toMatchObject({ prefilled_text: 'Hello' });
      expect(validation.card?.actions[1]).toMatchObject({ place_name: 'Cairo Road' });
    });

    it('accepts a label of exactly 32 characters, counting what people see (an emoji is one)', () => {
      expect(validateButtonDrafts([goodCall({ label: 'a'.repeat(32) })]).card).not.toBeNull();
      expect(validateButtonDrafts([goodCall({ label: '😀'.repeat(32) })]).card).not.toBeNull();
    });

    it('allows up to six buttons', () => {
      const six = Array.from({ length: 6 }, () => goodCall());
      expect(validateButtonDrafts(six).card?.actions).toHaveLength(6);
    });

    it('keeps a WhatsApp message with line breaks', () => {
      const validation = validateButtonDrafts([goodWhatsApp({ firstMessage: 'Hello\nI saw your ad' })]);
      expect(validation.card?.actions[0]).toMatchObject({ prefilled_text: 'Hello\nI saw your ad' });
    });
  });

  describe('what is wrong, in words, by button and field', () => {
    it('names an empty or unreadable phone number', () => {
      const empty = goodCall({ phoneText: '' });
      const unreadable = goodWhatsApp({ phoneText: '123' });
      const validation = validateButtonDrafts([empty, unreadable]);
      expect(validation.problemsByKey.get(empty.key)).toEqual({ phone: 'Enter the phone number.' });
      expect(validation.problemsByKey.get(unreadable.key)).toEqual({ phone: "That doesn't look like a phone number. Try something like 0977 123 456." });
      expect(validation.card).toBeNull();
    });

    it('names a label that is blank or too long', () => {
      const blank = goodCall({ label: '   ' });
      const tooLong = goodCall({ label: 'a'.repeat(33) });
      const validation = validateButtonDrafts([blank, tooLong]);
      expect(validation.problemsByKey.get(blank.key)?.label).toBe('Give the button a label, like “Call us”.');
      expect(validation.problemsByKey.get(tooLong.key)?.label).toBe('Keep the label to 32 characters or fewer.');
    });

    it('refuses a label with hidden or direction-changing characters', () => {
      const sneaky = goodCall({ label: 'Call\u202Eus' });
      expect(validateButtonDrafts([sneaky]).problemsByKey.get(sneaky.key)?.label).toBe("The label has a character we can't use. Type it again.");
    });

    it('explains each way a website address can be refused', () => {
      const cases: Array<[string, string]> = [
        ['', 'Paste the web address this button opens.'],
        ['http://brand.co.zm', 'Addresses must start with https:// (the secure kind). Ask the business for their secure address.'],
        ['bit.ly/abc', 'Short links like bit.ly hide where the button goes. Paste the full address instead.'],
        ['javascript:alert(1)', "That isn't a web page address. Paste the page's address, like brand.co.zm/offer."],
        ['https://brand.co.zm@evil.example', "Addresses with a name or password in them can't be used. Paste the plain address."],
        ['not an address', "That doesn't look like a web address. Try something like brand.co.zm/offer."],
      ];
      for (const [typed, words] of cases) {
        const button = goodLink({ webAddressText: typed });
        expect(validateButtonDrafts([button]).problemsByKey.get(button.key)?.webAddress, typed).toBe(words);
      }
    });

    it('explains each way a location can be refused', () => {
      const short = goodMap({ locationText: 'https://maps.app.goo.gl/AbCdEf' });
      const sea = goodMap({ locationText: '0, 0' });
      const nonsense = goodMap({ locationText: 'near the big tree' });
      const validation = validateButtonDrafts([short, sea, nonsense]);
      expect(validation.problemsByKey.get(short.key)?.location).toMatch(/^That's a short Maps link/);
      expect(validation.problemsByKey.get(sea.key)?.location).toMatch(/^0, 0 is in the sea/);
      expect(validation.problemsByKey.get(nonsense.key)?.location).toMatch(/^We couldn't find a place in that/);
    });

    it('names a first message or place name that is too long', () => {
      const message = goodWhatsApp({ firstMessage: 'a'.repeat(501) });
      const place = goodMap({ placeName: 'a'.repeat(81) });
      const validation = validateButtonDrafts([message, place]);
      expect(validation.problemsByKey.get(message.key)).toEqual({ firstMessage: 'Keep the first message to 500 characters or fewer.' });
      expect(validation.problemsByKey.get(place.key)).toEqual({ placeName: 'Keep the place name to 80 characters or fewer.' });
    });

    it('reports every field that is wrong in one button at once', () => {
      const bad = goodWhatsApp({ label: '', phoneText: '', firstMessage: 'a'.repeat(501) });
      const validation = validateButtonDrafts([bad]);
      expect(Object.keys(validation.problemsByKey.get(bad.key) ?? {}).sort()).toEqual(['firstMessage', 'label', 'phone']);
      expect(validation.problemCount).toBe(3);
    });

    it('does not mention buttons that are fine', () => {
      const bad = goodCall({ phoneText: '' });
      const fine = goodLink();
      const validation = validateButtonDrafts([fine, bad]);
      expect(validation.problemsByKey.has(fine.key)).toBe(false);
      expect(validation.problemsByKey.has(bad.key)).toBe(true);
    });

    it('never lets typed text reach the words: the same problem gives the same sentence', () => {
      const first = goodCall({ phoneText: '<script>alert(1)</script>' });
      const second = goodCall({ phoneText: 'abc' });
      const [one, two] = [validateButtonDrafts([first]), validateButtonDrafts([second])];
      expect(one.problemsByKey.get(first.key)?.phone).toBe(two.problemsByKey.get(second.key)?.phone);
      expect(one.problemsByKey.get(first.key)?.phone).not.toMatch(/script/);
    });
  });

  describe('the card as a whole', () => {
    it('needs at least one button', () => {
      const validation = validateButtonDrafts([]);
      expect(validation.card).toBeNull();
      expect(validation.cardProblem).toBe('Add at least one button, or listeners will have nothing to tap.');
    });

    it('allows no more than six', () => {
      const validation = validateButtonDrafts(Array.from({ length: 7 }, () => goodCall()));
      expect(validation.card).toBeNull();
      expect(validation.cardProblem).toBe('A card can have up to 6 buttons. Remove one to add another.');
    });

    it('is not saved while any button has a problem, even when the others are fine', () => {
      const validation = validateButtonDrafts([goodCall(), goodLink({ webAddressText: '' })]);
      expect(validation.card).toBeNull();
      expect(validation.cardProblem).toBeNull();
    });
  });

  describe('the preview', () => {
    it('shows the buttons that are right and leaves out the others until they are fixed, saying which', () => {
      const fine = goodCall();
      const broken = goodLink({ label: 'Book online', webAddressText: 'http://brand.co.zm' });
      const alsoFine = goodMap();
      const validation = validateButtonDrafts([fine, broken, alsoFine]);

      expect(validation.previewCard.actions.map((action) => action.id)).toEqual([fine.key, alsoFine.key]);
      expect(validation.hiddenFromPreview).toEqual([2]);
    });

    it('styles a button by its place in the list, so fixing a hidden first button brings back the main one', () => {
      const hiddenFirst = goodCall({ phoneText: '' });
      const second = goodLink();
      const { previewCard } = validateButtonDrafts([hiddenFirst, second]);
      expect(previewCard.actions[0]).toMatchObject({ id: second.key, style: 'SECONDARY' });
    });

    it('names the buttons it leaves out by their number, never by what was typed', () => {
      const validation = validateButtonDrafts([goodCall({ label: '', phoneText: '' }), goodCall(), goodCall({ label: 'Call\u202Eus' })]);
      expect(validation.hiddenFromPreview).toEqual([1, 3]);
      expect(describeHiddenButtons([2])).toBe('button 2');
      expect(describeHiddenButtons([1, 3])).toBe('buttons 1 and 3');
      expect(describeHiddenButtons([1, 2, 4])).toBe('buttons 1, 2 and 4');
    });

    it('is empty, not broken, with no buttons', () => {
      expect(validateButtonDrafts([]).previewCard.actions).toEqual([]);
    });
  });
});

describe('problems the API reports for a save', () => {
  const drafts = [goodCall(), goodWhatsApp(), goodMap()];

  it('ties each problem back to its button and field, in the same words as the checks here', () => {
    const problems = problemsFromApiFields(drafts, [
      { path: 'actions.1.phone_number_e164', code: 'zambian_number_must_have_nine_digits' },
      { path: 'actions.1.label', code: 'too_big' },
      { path: 'actions.2.latitude', code: 'map_location_is_zero_zero' },
    ]);
    expect(problems.get(drafts[1]?.key as string)).toEqual({
      phone: 'Zambian numbers have 9 digits after +260, like 0977 123 456.',
      label: 'Keep the label to 32 characters or fewer.',
    });
    expect(problems.get(drafts[2]?.key as string)?.location).toMatch(/^0, 0 is in the sea/);
    expect(problems.has(drafts[0]?.key as string)).toBe(false);
  });

  it('ignores paths it does not understand, and buttons that are no longer there', () => {
    expect(problemsFromApiFields(drafts, [{ path: 'actions.9.label', code: 'too_big' }, { path: '', code: 'custom' }, { path: 'actions', code: 'too_big' }, { path: 'actions.0.unknown_field', code: 'x' }]).size).toBe(0);
  });

  it('says "Check this one." for a reason it has no sentence for, never the code itself', () => {
    const problems = problemsFromApiFields(drafts, [{ path: 'actions.0.label', code: 'something_new' }]);
    expect(problems.get(drafts[0]?.key as string)).toEqual({ label: 'Check this one.' });
  });
});
