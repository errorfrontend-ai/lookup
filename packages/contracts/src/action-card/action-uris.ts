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
      if (!action.prefilledText) return `https://wa.me/${digitsOnly}`;
      const encodedText = encodeOrNull(action.prefilledText);
      return encodedText === null ? null : `https://wa.me/${digitsOnly}?text=${encodedText}`;
    }
    case 'MAP': {
      // A listener's map button opens directions to the place (design S4-D16), not a search for it.
      const coordinates = formatCoordinates(action.latitude, action.longitude);
      return coordinates ? `https://www.google.com/maps/dir/?api=1&destination=${coordinates}` : null;
    }
    case 'LINK':
      return isCanonicalHttpsLink(action.url) ? action.url : null;
  }
}

/**
 * A Google Maps address that shows the pin itself, for a station checking where a map button points
 * (the portal's "Check on Google Maps"). Listeners get directions instead (buildActionUri).
 */
export function buildMapSearchAddress(latitude: number, longitude: number): string | null {
  const coordinates = formatCoordinates(latitude, longitude);
  return coordinates ? `https://www.google.com/maps/search/?api=1&query=${coordinates}` : null;
}

/**
 * "latitude%2Clongitude" with six fixed decimals (about 10 cm), so every platform prints the same text
 * (Dart prints 28.0 where JavaScript prints 28, and -0.000000 where JavaScript prints 0.000000).
 * Null when either is not a finite number in range.
 */
function formatCoordinates(latitude: number, longitude: number): string | null {
  const isInRange = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return isInRange ? `${latitude.toFixed(6)}%2C${longitude.toFixed(6)}` : null;
}

/** encodeURIComponent, but null instead of throwing on text it cannot encode (a lone surrogate). */
function encodeOrNull(text: string): string | null {
  try {
    return encodeURIComponent(text);
  } catch {
    return null;
  }
}

function isPhoneNumberE164(value: string): boolean {
  return /^\+[1-9][0-9]{6,14}$/.test(value);
}
