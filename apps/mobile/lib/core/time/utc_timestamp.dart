/// A time as the contract writes it (contract §1.1, §1.5): UTC, ISO 8601, exactly three decimal
/// places and `Z`, e.g. `2026-10-08T09:15:02.123Z`. Written out because Dart's `toIso8601String()`
/// writes a local time without a zone (which the contract refuses) and six decimals when there are
/// microseconds.
abstract final class UtcTimestamp {
  static String format(DateTime time) {
    final utc = time.toUtc();
    String twoDigits(int value) => value.toString().padLeft(2, '0');
    return '${utc.year.toString().padLeft(4, '0')}-${twoDigits(utc.month)}-${twoDigits(utc.day)}'
        'T${twoDigits(utc.hour)}:${twoDigits(utc.minute)}:${twoDigits(utc.second)}'
        '.${utc.millisecond.toString().padLeft(3, '0')}Z';
  }
}
