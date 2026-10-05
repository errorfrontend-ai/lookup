import { isCanonicalHttpsLink } from './action-card-reader.js';
import type { ReadAction } from './action-card-reader.js';

/**
 * The address each button opens. The listener app builds these itself from the card's semantic
 * fields (it never receives a ready-made tel: or wa.me link), so a card can never smuggle in
 * `javascript:` or another scheme. The app's Dart builder is tested against the same fixtures
 * (fixtures/action-card/action-uris.json). Returns null when the action cannot be opened safely.
 */
export function buildActionUri(action: ReadAction): string | null {
  switch (action.type) {
    case 'CALL':
      return isPhoneNumberE164(action.phoneNumberE164) ? `tel:${action.phoneNumberE164}` : null;
    case 'WHATSAPP': {
      if (!isPhoneNumberE164(action.phoneNumberE164)) return null;
      const digitsOnly = action.phoneNumberE164.slice(1);
      return action.prefilledText
        ? `https://wa.me/${digitsOnly}?text=${encodeURIComponent(action.prefilledText)}`
        : `https://wa.me/${digitsOnly}`;
    }
    case 'MAP': {
      const { latitude, longitude } = action;
      const isInRange = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
      // Six fixed decimals (about 10 cm) so every platform prints the same text (Dart prints 28.0 where JavaScript prints 28).
      return isInRange
        ? `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)}%2C${longitude.toFixed(6)}`
        : null;
    }
    case 'LINK':
      return isCanonicalHttpsLink(action.url) ? action.url : null;
  }
}

function isPhoneNumberE164(value: string): boolean {
  return /^\+[1-9][0-9]{6,14}$/.test(value);
}
