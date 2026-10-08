import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;

import '../configuration/app_configuration.dart';
import '../time/clock.dart';
import 'personal_data_scrubber.dart';

/// The app's only device log (design §3.19). It writes nothing unless the build is the development
/// flavour with `LOOKUP_VERBOSE_LOGS` on, so staging and production builds write no audio, token,
/// install id, phone number or request body to the device log (S4-PRIVACY-04). Even when on, it
/// writes one JSON object per line (searchable, and a newline in a value cannot forge a line),
/// request lines carry only method, path, outcome, duration and request id, and every free text is
/// scrubbed first.
///
/// `print` and `debugPrint` appear nowhere else in the app.
class DevelopmentLog {
  /// A log that is on only for a development build with verbose logs. [writeLine] and [clock] are
  /// for tests; the app writes through `debugPrint` with the wall clock.
  DevelopmentLog({
    required AppConfiguration configuration,
    void Function(String line)? writeLine,
    Clock? clock,
  }) : isOn = configuration.flavour == AppFlavour.development && configuration.writesVerboseLogs,
       _writeLine = writeLine ?? _writeToDeviceLog,
       _clock = clock;

  /// A log that never writes, for code built before the configuration is known and for tests.
  const DevelopmentLog.off() : isOn = false, _writeLine = _writeNothing, _clock = null;

  /// Whether anything is written at all.
  final bool isOn;

  final void Function(String line) _writeLine;
  final Clock? _clock;

  /// One line for one HTTP attempt: never headers, bodies, tokens or audio.
  void recordRequest({
    required String method,
    required String path,
    required String requestId,
    required Duration duration,
    int? status,
    String? noAnswerReason,
  }) {
    if (!isOn) return;
    _write('api request', {
      'method': method,
      'path': path,
      'status': ?status,
      'noAnswerReason': ?noAnswerReason,
      'durationMilliseconds': duration.inMilliseconds,
      'requestId': requestId,
    });
  }

  /// One line for something a developer should see, with [detail] and [stackTrace] scrubbed.
  void recordEvent(String event, {String? detail, StackTrace? stackTrace}) {
    if (!isOn) return;
    _write(PersonalDataScrubber.scrub(event), {
      if (detail != null) 'detail': PersonalDataScrubber.scrub(detail),
      if (stackTrace != null) 'stack': PersonalDataScrubber.scrub(stackTrace.toString()),
    });
  }

  void _write(String event, Map<String, Object> fields) {
    try {
      final time = _clock?.now() ?? DateTime.now().toUtc();
      _writeLine(jsonEncode({'time': time.toIso8601String(), 'event': event, ...fields}));
    } on Object {
      // Logging is for developers only; it must never break what it describes.
    }
  }

  static void _writeToDeviceLog(String line) => debugPrint(line);

  static void _writeNothing(String line) {}
}
