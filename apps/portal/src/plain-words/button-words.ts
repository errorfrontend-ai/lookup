import type { ButtonField, ButtonKind } from '../features/ad-buttons/button-draft';

export const BUTTON_KIND_WORDS: Record<ButtonKind, { name: string; addLabel: string; description: string }> = {
  CALL: { name: 'Call', addLabel: 'Call', description: 'Opens the phone, ready to call.' },
  WHATSAPP: { name: 'WhatsApp', addLabel: 'WhatsApp', description: 'Opens a WhatsApp chat with the business.' },
  MAP: { name: 'Directions', addLabel: 'Directions', description: 'Opens the map at the business.' },
  LINK: { name: 'Website', addLabel: 'Website', description: 'Opens a web page.' },
};

/** "button 2", "buttons 2 and 4", "buttons 1, 2 and 4": the buttons the preview leaves out until they are fixed. */
export function describeHiddenButtons(numbers: readonly number[]): string {
  if (numbers.length === 1) return `button ${numbers[0]}`;
  return `buttons ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

export const NO_BUTTONS_PROBLEM = 'Add at least one button, or listeners will have nothing to tap.';
export const TOO_MANY_BUTTONS_PROBLEM = 'A card can have up to 6 buttons. Remove one to add another.';
export const CARD_NOT_SAVABLE_PROBLEM = "These buttons can't be saved as they are. Check each one.";

/** What went wrong with one field of a button, and what to do about it. Codes come from the readers and from the card's own rules. */
const PROBLEM_WORDS: Record<ButtonField, Record<string, string>> = {
  label: {
    too_small: 'Give the button a label, like “Call us”.',
    too_big: 'Keep the label to 32 characters or fewer.',
    invalid_format: "The label has a character we can't use. Type it again.",
  },
  phone: {
    empty: 'Enter the phone number.',
    unreadable: "That doesn't look like a phone number. Try something like 0977 123 456.",
    zambian_number_must_have_nine_digits: 'Zambian numbers have 9 digits after +260, like 0977 123 456.',
    invalid_format: "That doesn't look like a phone number. Try something like 0977 123 456.",
  },
  firstMessage: {
    too_big: 'Keep the first message to 500 characters or fewer.',
    invalid_format: "The message has a character we can't use. Type it again.",
  },
  webAddress: {
    empty: 'Paste the web address this button opens.',
    not_secure: 'Addresses must start with https:// (the secure kind). Ask the business for their secure address.',
    not_a_web_address: "That isn't a web page address. Paste the page's address, like brand.co.zm/offer.",
    unreadable: "That doesn't look like a web address. Try something like brand.co.zm/offer.",
    has_login: "Addresses with a name or password in them can't be used. Paste the plain address.",
    shortener: 'Short links like bit.ly hide where the button goes. Paste the full address instead.',
    link_uses_url_shortener: 'Short links like bit.ly hide where the button goes. Paste the full address instead.',
    too_long: 'That address is too long. Use a shorter one.',
    link_must_be_canonical_https: "That doesn't look like a web address. Try something like brand.co.zm/offer.",
    invalid_format: "That doesn't look like a web address. Try something like brand.co.zm/offer.",
  },
  location: {
    empty: 'Paste a Google Maps link, or type the latitude and longitude.',
    unreadable: "We couldn't find a place in that. Paste a Google Maps link, or type latitude and longitude like -15.4167, 28.2833.",
    short_link: "That's a short Maps link, which we can't open from here. Open it in Google Maps, copy the address from the browser's address bar, and paste that. Or type the latitude and longitude.",
    out_of_range: 'Latitude must be between -90 and 90, and longitude between -180 and 180. Check the order: latitude first.',
    zero_zero: "0, 0 is in the sea off Africa. That's usually what shows when a location is missing. Enter the real place.",
    map_location_is_zero_zero: "0, 0 is in the sea off Africa. That's usually what shows when a location is missing. Enter the real place.",
  },
  placeName: {
    too_big: 'Keep the place name to 80 characters or fewer.',
    invalid_format: "The place name has a character we can't use. Type it again.",
  },
};

export function describeButtonProblem(field: ButtonField, code: string): string {
  return PROBLEM_WORDS[field][code] ?? 'Check this one.';
}

/** How a card's field names (as the API reports them) map to the fields a person sees. */
export const FIELD_FOR_CARD_PROPERTY: Record<string, ButtonField> = {
  label: 'label',
  phone_number_e164: 'phone',
  prefilled_text: 'firstMessage',
  url: 'webAddress',
  latitude: 'location',
  longitude: 'location',
  place_name: 'placeName',
};
