import { formatPhoneNumberForDisplay, type ReadAction } from '@lookup/contracts';

/** Where a button takes the listener, written out for the station to check. */
export function describeButtonDestination(action: ReadAction): string {
  switch (action.type) {
    case 'CALL':
      return formatPhoneNumberForDisplay(action.phoneNumberE164);
    case 'WHATSAPP':
      return action.prefilledText ? `${formatPhoneNumberForDisplay(action.phoneNumberE164)} · first message: “${action.prefilledText}”` : formatPhoneNumberForDisplay(action.phoneNumberE164);
    case 'MAP':
      return action.placeName ? `${action.placeName} (${action.latitude.toFixed(4)}, ${action.longitude.toFixed(4)})` : `${action.latitude.toFixed(4)}, ${action.longitude.toFixed(4)}`;
    case 'LINK':
      return action.url;
  }
}
