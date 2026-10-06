export type MapLocationProblem = 'empty' | 'unreadable' | 'short_link' | 'out_of_range' | 'zero_zero';

export type MapLocationReading = { kind: 'found'; latitude: number; longitude: number } | { kind: 'problem'; problem: MapLocationProblem };

const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;
const PLAIN_PAIR = new RegExp(`^\\(?\\s*(${NUMBER})\\s*[,;\\s]\\s*(${NUMBER})\\s*\\)?$`);
// "15.4167° S, 28.2833° E", as Google shows a place's coordinates: south and west are negative.
const COMPASS_PAIR = /^(\d{1,3}(?:\.\d+)?)\s*°?\s*([NS])\s*[,;\s]\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])$/i;

const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;
const SHORT_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co', 'g.page']);
/** The pin Google puts in a place's address: "...!3d-15.4167!4d28.2834...". The most exact of the places coordinates appear. */
const PLACE_PIN = /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/;
/** The map's centre: "/@-15.4167,28.2833,17z". Close to the place, but only the middle of what was on screen. */
const MAP_CENTRE = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/;
const COORDINATE_PARAMETERS = ['q', 'query', 'll', 'destination', 'daddr', 'center'] as const;
const SIX_DECIMALS = 1_000_000;

function checked(latitude: number, longitude: number): MapLocationReading {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { kind: 'problem', problem: 'out_of_range' };
  // Six decimals is about ten centimetres: more is false precision, and it keeps the card short.
  const roundedLatitude = Math.round(latitude * SIX_DECIMALS) / SIX_DECIMALS;
  const roundedLongitude = Math.round(longitude * SIX_DECIMALS) / SIX_DECIMALS;
  // Checked after rounding, because 0, 0 is what the card refuses, and that is what would be saved.
  if (roundedLatitude === 0 && roundedLongitude === 0) return { kind: 'problem', problem: 'zero_zero' };
  return { kind: 'found', latitude: roundedLatitude, longitude: roundedLongitude };
}

function readPair(text: string): MapLocationReading | null {
  const cleaned = text.replace(/−/g, '-').replace(/°/g, (match, offset: number) => (/[NSEWnsew]/.test(text.slice(offset + 1, offset + 3)) ? match : ''));
  const compass = COMPASS_PAIR.exec(cleaned.trim());
  if (compass) {
    const latitude = Number(compass[1]) * (compass[2]?.toUpperCase() === 'S' ? -1 : 1);
    const longitude = Number(compass[3]) * (compass[4]?.toUpperCase() === 'W' ? -1 : 1);
    return checked(latitude, longitude);
  }
  const plain = PLAIN_PAIR.exec(cleaned.trim());
  return plain ? checked(Number(plain[1]), Number(plain[2])) : null;
}

function readGoogleMapsLink(url: URL): MapLocationReading | null {
  if (SHORT_LINK_HOSTS.has(url.hostname)) return { kind: 'problem', problem: 'short_link' };
  if (!GOOGLE_HOST.test(url.hostname)) return null;
  const decoded = decodeURIComponent(url.href.replace(/\+/g, ' '));
  const pin = PLACE_PIN.exec(decoded);
  if (pin) return checked(Number(pin[1]), Number(pin[2]));
  for (const name of COORDINATE_PARAMETERS) {
    const value = url.searchParams.get(name);
    const fromParameter = value ? readPair(value) : null;
    if (fromParameter) return fromParameter;
  }
  const centre = MAP_CENTRE.exec(decoded);
  return centre ? checked(Number(centre[1]), Number(centre[2])) : null;
}

/**
 * Reads where a button's "Directions" should go from what a station pastes: a Google Maps link
 * (the pin in a place link, a search or directions link with coordinates, or a map's centre), or two
 * numbers, latitude then longitude ("-15.4167, 28.2833", or "15.4167° S, 28.2833° E"). Nothing is
 * looked up on the internet, so a short link (maps.app.goo.gl) can't be followed: it is named as such
 * and the station is told what to paste instead.
 */
export function parseMapLocation(input: string): MapLocationReading {
  const text = input.trim();
  if (text === '') return { kind: 'problem', problem: 'empty' };

  const asPair = readPair(text);
  if (asPair) return asPair;

  const looksLikeLink = /^(https?:\/\/|www\.|maps\.|google\.|goo\.gl|g\.co)/i.test(text);
  if (looksLikeLink) {
    try {
      const reading = readGoogleMapsLink(new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`));
      if (reading) return reading;
    } catch {
      return { kind: 'problem', problem: 'unreadable' };
    }
  }
  return { kind: 'problem', problem: 'unreadable' };
}
