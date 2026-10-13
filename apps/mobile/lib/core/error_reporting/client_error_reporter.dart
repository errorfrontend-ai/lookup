import 'package:dio/dio.dart' show DioException;

import '../configuration/app_version.dart';
import '../listener_install/listener_install_credentials.dart';
import '../network/api_client.dart';
import '../time/clock.dart';
import 'client_error_kind.dart';
import 'client_error_report_outcome.dart';
import 'development_log.dart';
import 'personal_data_scrubber.dart';

export 'client_error_kind.dart';
export 'client_error_report_outcome.dart';

/// Keeps a crash report that got no answer, to send later (the outbox's `queueClientErrorReport`).
typedef UnsentClientErrorReportQueue =
    Future<void> Function({
      required String reportId,
      required DateTime occurredAt,
      required Map<String, String> fields,
    });

/// Sends the app's crash reports to `POST <base>/client-errors` (Step 2's route), so client crashes
/// reach the developers (design §3.19, S4-D26).
///
/// - The body is exactly the contract's `ClientErrorReport`
///   (packages/contracts/schemas/client-error-report.schema.json), cut to its limits.
/// - Each report carries its own new `X-Request-Id` and never the install token.
/// - Text is scrubbed on the phone first: the stored install token and id, then what the server's
///   scrubber removes. The text of a `FormatException` (it can quote the answer, cards included)
///   or of a `DioException` is never used, only its type and the app's own description.
/// - At most one report of the same error a minute and 10 reports a minute leave the phone: the
///   API allows 30 a minute per address, and many listeners can share one carrier address.
/// - It never throws, and a failure while reporting is not reported.
/// - A report that gets no answer (no network, a timeout, a dropped connection) is handed to the
///   outbox through [attachUnsentReportQueue], which sends it later under the same id with the time
///   it happened (P6 design §3.20, P6-ERRORREPORTING-05); it still counts as not accepted, so a phone
///   failure shows no reference code for it.
class ClientErrorReporter {
  /// [readInstallCredentials] gives the install id and token to scrub (the repository's
  /// `readKnownCredentials`). [clock], [appVersion] and [developmentLog] are for tests and
  /// development builds.
  ClientErrorReporter({
    required ApiClient apiClient,
    Future<ListenerInstallCredentials?> Function()? readInstallCredentials,
    Clock? clock,
    String appVersion = AppVersion.current,
    DevelopmentLog developmentLog = const DevelopmentLog.off(),
  }) : _apiClient = apiClient,
       _readInstallCredentials = readInstallCredentials,
       _clock = clock ?? Clock(),
       _appVersion = appVersion,
       _developmentLog = developmentLog;

  /// The route, relative to the API's base address. It carries no install token.
  static const String path = ListenerRoute.clientErrors;

  /// The contract's `source` for this app.
  static const String source = 'listener-app';

  /// The contract's limits, in characters.
  static const int longestMessage = 500;
  static const int longestStack = 8000;
  static const int longestLocation = 300;
  static const int longestAppVersion = 40;

  /// How many reports may leave the phone in [rateWindow], and how often the same error may.
  static const int maximumReportsPerWindow = 10;
  static const Duration rateWindow = Duration(minutes: 1);

  /// Exception types whose text is never sent: a `FormatException` can quote the answer it failed
  /// to read, cards included; a `DioException`'s text names addresses and settings.
  static const List<String> textWithheldTypeNames = ['FormatException', 'DioException'];

  /// What stands for an exception whose text is withheld.
  static String withheldDescriptionFor(String typeName) => '$typeName (its text is not sent)';

  /// The message sent when nothing describes the error at all; the contract needs one.
  static const String undescribedMessage = 'An error with no description';

  static final RegExp _requestIdUuid = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  );

  final ApiClient _apiClient;
  final Future<ListenerInstallCredentials?> Function()? _readInstallCredentials;
  final Clock _clock;
  final String _appVersion;
  final DevelopmentLog _developmentLog;

  /// When each distinct error was last sent, on the monotonic clock.
  final Map<String, Duration> _lastSentAtByError = {};

  /// When each report in the current window was sent, on the monotonic clock.
  final List<Duration> _sentAtTimes = [];

  /// Keeps a report that got no answer, to send later; null until the outbox attaches itself.
  UnsentClientErrorReportQueue? _unsentReportQueue;

  /// Lets [queue] keep the reports that get no answer (the outbox, once it exists: it reports its
  /// own failures through this reporter, so it is attached after both are made).
  void attachUnsentReportQueue(UnsentClientErrorReportQueue queue) => _unsentReportQueue = queue;

  /// Reports [error] and resolves to whether the API accepted it. Never throws.
  ///
  /// [error] is the exception, or the app's own words as a string. [description] is the app's own
  /// words about where it happened. [location] is the current route path, e.g. `/listening`.
  /// [relatedRequestId] is the failing call's request id, when there is one. [reportRequestId] is
  /// for a caller that must know the report's id before it is sent (a phone failure whose reference
  /// code it becomes); it must be a fresh version-4 UUID, and anything else is replaced.
  Future<ClientErrorReportOutcome> report({
    required ClientErrorKind kind,
    required Object error,
    StackTrace? stackTrace,
    String? description,
    String? location,
    String? relatedRequestId,
    String? reportRequestId,
  }) async {
    try {
      final message = describe(error, description: description);
      final stack = stackTrace?.toString();
      // Decided before any wait, so reports made at the same moment are counted one by one.
      if (!_mayReport(_errorKey(message, stack))) return const ClientErrorReportHeldBack();

      final credentials = await _readCredentialsQuietly();
      String scrub(String text) => PersonalDataScrubber.scrub(
        text,
        installId: credentials?.installId,
        installToken: credentials?.installToken,
      );

      final scrubbedMessage = _shortened(scrub(message).trim(), longestMessage);
      final scrubbedStack = stack == null ? '' : _shortened(scrub(stack), longestStack);
      final scrubbedLocation = location == null
          ? ''
          : _shortened(scrub(PersonalDataScrubber.pathOnly(location)), longestLocation);
      final body = <String, Object?>{
        'source': source,
        'kind': kind.wireName,
        'message': scrubbedMessage.isEmpty ? undescribedMessage : scrubbedMessage,
        if (scrubbedStack.isNotEmpty) 'stack': scrubbedStack,
        if (scrubbedLocation.isNotEmpty) 'location': scrubbedLocation,
        if (relatedRequestId != null && _requestIdUuid.hasMatch(relatedRequestId))
          'relatedRequestId': relatedRequestId,
        if (_appVersion.isNotEmpty) 'appVersion': _shortened(_appVersion, longestAppVersion),
      };

      final occurredAt = _clock.now();
      final answer = await _apiClient.postJson(path, body, requestId: reportRequestId);
      if (answer case ApiAnswerNotReceived(
        reason: ApiNoAnswerReason.noConnection ||
            ApiNoAnswerReason.timedOut ||
            ApiNoAnswerReason.connectionDropped,
        :final sentRequestId,
      )) {
        await _queueQuietly(sentRequestId, occurredAt, body);
      }
      final outcome = switch (answer) {
        ApiAnswerReceived(status: 202, :final sentRequestId) => ClientErrorReportAccepted(
          sentRequestId,
        ),
        _ => const ClientErrorReportNotAccepted(),
      };
      // The API client's request line already carries the report's request id and status.
      _developmentLog.recordEvent(
        outcome.isAccepted ? 'crash report accepted' : 'crash report not accepted',
      );
      return outcome;
    } on Object {
      // Reporting must never fail what it reports, and a failure here is not reported again.
      return const ClientErrorReportNotAccepted();
    }
  }

  /// Hands a report that got no answer to the outbox, with its own id and the time it happened. A
  /// failure here is not reported: that would only make another report to queue.
  Future<void> _queueQuietly(
    String reportId,
    DateTime occurredAt,
    Map<String, Object?> body,
  ) async {
    final queue = _unsentReportQueue;
    if (queue == null) return;
    try {
      await queue(
        reportId: reportId,
        occurredAt: occurredAt,
        fields: {
          for (final MapEntry(:key, :value) in body.entries)
            if (value is String) key: value,
        },
      );
      _developmentLog.recordEvent('crash report kept to send later');
    } on Object {
      // Kept nowhere: the report is lost, as it would have been before the outbox.
    }
  }

  /// The words a report uses for [error]: the string itself when the app wrote it, the type alone
  /// for a type whose text is withheld, otherwise the error's own description. Not yet scrubbed.
  static String describe(Object error, {String? description}) {
    final String errorText;
    if (error is String) {
      errorText = error;
    } else if (error is FormatException || error is DioException) {
      errorText = withheldDescriptionFor(
        error is FormatException ? 'FormatException' : 'DioException',
      );
    } else {
      errorText = _describeSafely(error);
    }
    if (description == null || description.isEmpty) return errorText;
    return errorText.isEmpty ? description : '$description: $errorText';
  }

  static String _describeSafely(Object error) {
    try {
      return error.toString();
    } on Object {
      // An error whose own description fails is still reported, by its type.
      return error.runtimeType.toString();
    }
  }

  /// The same error is the same message with the same first stack line.
  static String _errorKey(String message, String? stack) {
    final firstStackLine = stack == null ? '' : stack.split('\n').first;
    return '$message\n$firstStackLine';
  }

  bool _mayReport(String errorKey) {
    final now = _clock.monotonicElapsed();
    _sentAtTimes.removeWhere((sentAt) => now - sentAt >= rateWindow);
    _lastSentAtByError.removeWhere((_, sentAt) => now - sentAt >= rateWindow);
    if (_lastSentAtByError.containsKey(errorKey)) return false;
    if (_sentAtTimes.length >= maximumReportsPerWindow) return false;
    _lastSentAtByError[errorKey] = now;
    _sentAtTimes.add(now);
    return true;
  }

  Future<ListenerInstallCredentials?> _readCredentialsQuietly() async {
    try {
      return await _readInstallCredentials?.call();
    } on Object {
      // Without them, the patterns still remove long token-like text such as either secret.
      return null;
    }
  }

  /// [text] cut to at most [longest] UTF-16 code units (the API's own count), ending with "…" when
  /// cut and never splitting a character in two.
  static String _shortened(String text, int longest) {
    if (text.length <= longest) return text;
    var end = longest - 1;
    final lastKept = text.codeUnitAt(end - 1);
    if (lastKept >= 0xD800 && lastKept <= 0xDBFF) end -= 1;
    return '${text.substring(0, end)}$_ellipsis';
  }

  /// "…", by its code so no editor can change it.
  static final String _ellipsis = String.fromCharCode(0x2026);
}
