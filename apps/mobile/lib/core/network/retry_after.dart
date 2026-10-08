import 'dart:io' show HttpDate;

/// Reads the `Retry-After` header (RFC 9110 §10.2.3): whole seconds, or an HTTP date. The API sends
/// seconds (502–504, 409, 429); a proxy in between may send a date.
///
/// It only reads the header. Clamping the wait to 1–60 seconds and choosing a default when the
/// header is missing (10 s for busy and 429, 3 s for 409) is the identify domain's job (S4-D11),
/// because "Too many tries" also needs to know when the server asked for more than a minute.
abstract final class RetryAfter {
  /// Whole seconds, at most six digits: anything longer is not a wait a phone should honour, and
  /// keeps the number far from overflowing.
  static final RegExp _wholeSeconds = RegExp(r'^[0-9]{1,6}$');

  /// The wait [value] asks for, exactly as the header says it and never clamped; null when [value]
  /// is missing, empty or unreadable, so the caller uses its default. A date is measured from
  /// [now] and rounded up to the whole second (the app never sends early); a date already passed
  /// gives zero or less, which the caller's clamp turns into its shortest wait.
  static Duration? parse(String? value, {required DateTime now}) {
    if (value == null) return null;
    final text = value.trim();
    if (text.isEmpty) return null;
    if (_wholeSeconds.hasMatch(text)) return Duration(seconds: int.parse(text));

    final DateTime date;
    try {
      date = HttpDate.parse(text);
    } on Exception {
      // dart:io reports an unreadable date as an HttpException; any other failure is just as
      // unreadable.
      return null;
    }
    final waitMicroseconds = date.difference(now.toUtc()).inMicroseconds;
    return Duration(seconds: (waitMicroseconds / Duration.microsecondsPerSecond).ceil());
  }
}
