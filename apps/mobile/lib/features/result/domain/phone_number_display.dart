final RegExp _zambianPhoneNumber = RegExp(r'^\+260([0-9]{2})([0-9]{3})([0-9]{4})$');

/// A phone number as a person reads it: a Zambian number grouped as `+260 97 712 3456`, any other
/// number exactly as stored. Shown on the "Couldn't open this" sheet, while the clipboard gets the
/// E.164 form. Mirrors `formatPhoneNumberForDisplay` in `packages/contracts/src/phone-numbers/`, so the
/// listener sees the grouping the station confirmed in the portal.
String formatPhoneNumberForDisplay(String phoneNumberE164) {
  final zambianMatch = _zambianPhoneNumber.firstMatch(phoneNumberE164);
  if (zambianMatch == null) return phoneNumberE164;
  return '+260 ${zambianMatch.group(1)} ${zambianMatch.group(2)} ${zambianMatch.group(3)}';
}
