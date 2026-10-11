import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;

import '../configuration/app_configuration.dart';
import '../time/clock.dart';
import 'personal_data_scrubber.dart';

/// The app's only device log (design §3.19). It writes nothing unless the build is the development
/// flavour with `LOOKUP_VERBOSE_LOGS` on, or, for a request that got no answer only, the development
/// flavour with `LOOKUP_SHOW_DEVELOPER_TOOLS` on (the emulator's build, P6 design fact 21). So
/// staging and production builds write no audio, token, install id, phone number or request body to
/// the device log (S4-PRIVACY-04). Even when on, it
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
       recordsNoAnswerReasons =
           configuration.flavour == AppFlavour.development &&
           (configuration.writesVerboseLogs || configuration.showsDeveloperTools),
       _writeLine = writeLine ?? _writeToDeviceLog,
       _clock = clock;

  /// A log that never writes, for code built before the configuration is known and for tests.
  const DevelopmentLog.off()
    : isOn = false,
      recordsNoAnswerReasons = false,
      _writeLine = _writeNothing,
      _clock = null;

  /// The event of the one line a development build with its developer tools writes even with
  /// verbose logs off: a request that got no answer, and why.
  static const String noAnswerEvent = 'api request without answer';

  /// Whether everything is written: a development build with verbose logs.
  final bool isOn;

  /// Whether a request that got no answer is written with its reason: a development build with
  /// verbose logs or with its developer tools (the emulator's build). Never in staging or
  /// production, which the configuration check refuses developer tools and verbose logs in.
  final bool recordsNoAnswerReasons;

  final void Function(String line) _writeLine;
  final Clock? _clock;

  /// One line for one HTTP attempt: never headers, bodies, tokens or audio. [noAnswerReason] is
  /// why no answer came (`ApiNoAnswerReason`'s name), and [faultTypeName] the type of a fault on the
  /// phone, never its text.
  ///
  /// A request that got no answer is also written when the build shows its developer tools
  /// ([recordsNoAnswerReasons]), with verbose logs off: the emulator run reads that one line to
  /// record why the app saw no answer (P6 design fact 21, §4.8).
  void recordRequest({
    required String method,
    required String path,
    required String requestId,
    required Duration duration,
    int? status,
    String? noAnswerReason,
    String? faultTypeName,
  }) {
    if (!isOn && !(recordsNoAnswerReasons && noAnswerReason != null)) return;
    _write(isOn ? 'api request' : noAnswerEvent, {
      'method': method,
      'path': path,
      'status': ?status,
      'noAnswerReason': ?noAnswerReason,
      'faultTypeName': ?faultTypeName,
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
