import '../network/api_answer.dart';
import '../network/retry_after.dart';

/// What one send of an outbox item came to, as the acknowledgement policy reads it (P6 design §3.9
/// point 8): an HTTP answer, no answer at all, or a fault on the phone. Each kind's sender makes it
/// from the `ApiAnswer` it got; the API's `message` is never kept, so nothing technical travels on.
sealed class OutboxSendAnswer {
  const OutboxSendAnswer();

  /// Reads [answer] the way every kind does: the status, the envelope's code when the body is one,
  /// the `Retry-After` in whole seconds (a date measured from [now]) and the API's request id; no
  /// answer over the network, or the listener's cancel, is [OutboxNoAnswer]; a request the phone
  /// itself stopped is [OutboxPhoneFault].
  static OutboxSendAnswer fromApiAnswer(ApiAnswer answer, {required DateTime now}) =>
      switch (answer) {
        ApiAnswerNotReceived(
          reason: ApiNoAnswerReason.noConnection ||
              ApiNoAnswerReason.timedOut ||
              ApiNoAnswerReason.connectionDropped ||
              ApiNoAnswerReason.cancelled,
        ) =>
          const OutboxNoAnswer(),
        ApiAnswerNotReceived(reason: ApiNoAnswerReason.plainHttpRefused) => const OutboxPhoneFault(
          problem: 'the address is plain http outside the development flavour',
        ),
        ApiAnswerNotReceived(reason: ApiNoAnswerReason.unexpectedFailure, :final faultTypeName) =>
          OutboxPhoneFault(
            problem: faultTypeName == null
                ? 'a fault in the app'
                : 'a fault in the app ($faultTypeName)',
          ),
        ApiAnswerReceived(:final status, :final body, :final echoedRequestId, :final retryAfter) =>
          OutboxHttpAnswer(
            httpStatus: status,
            errorCode: _errorCodeIn(body),
            retryAfterSeconds: RetryAfter.parse(retryAfter, now: now)?.inSeconds,
            apiRequestId: _apiRequestIdFrom(echoedRequestId, body),
          ),
      };

  /// The envelope's `error.code` when it is well formed; null otherwise.
  static String? _errorCodeIn(ApiAnswerBody body) {
    if (body case JsonAnswerBody(
      value: {'error': {'code': final String code}},
    ) when _errorCode.hasMatch(code)) {
      return code;
    }
    return null;
  }

  /// The `X-Request-Id` header when it is a UUID, else the envelope's request id when that is one;
  /// lower case, as the API logs it.
  static String? _apiRequestIdFrom(String? header, ApiAnswerBody body) {
    final envelopeRequestId = switch (body) {
      JsonAnswerBody(value: {'error': {'request_id': final String requestId}}) => requestId,
      _ => null,
    };
    for (final candidate in [header, envelopeRequestId]) {
      if (candidate != null && _requestIdUuid.hasMatch(candidate)) return candidate.toLowerCase();
    }
    return null;
  }

  static final RegExp _errorCode = RegExp(r'^[A-Z][A-Z0-9_]{1,63}$');
  static final RegExp _requestIdUuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
}

/// An HTTP answer arrived, with any status.
final class OutboxHttpAnswer extends OutboxSendAnswer {
  const OutboxHttpAnswer({
    required this.httpStatus,
    this.errorCode,
    this.retryAfterSeconds,
    this.apiRequestId,
    this.isBodyUnreadable = false,
  });

  final int httpStatus;

  /// The envelope's `error.code` when well formed; null otherwise. An unknown code is handled by
  /// its status.
  final String? errorCode;

  /// The `Retry-After` in whole seconds as read, before any clamping; null when missing or
  /// unreadable.
  final int? retryAfterSeconds;

  /// The API's id for the answer (a UUID it logged), for a crash report's related request id.
  final String? apiRequestId;

  /// A success whose body the kind's reader could not read (a deferred clip's 200), which is
  /// deleted with a crash report.
  final bool isBodyUnreadable;

  @override
  String toString() =>
      'HTTP $httpStatus${errorCode == null ? '' : ' $errorCode'}'
      '${retryAfterSeconds == null ? '' : ' Retry-After $retryAfterSeconds'}';
}

/// No answer came: no network, a timeout or a dropped connection.
final class OutboxNoAnswer extends OutboxSendAnswer {
  const OutboxNoAnswer();

  @override
  String toString() => 'no answer';
}

/// The phone itself stopped the send, or could not build it: a fault in the app.
final class OutboxPhoneFault extends OutboxSendAnswer {
  const OutboxPhoneFault({required this.problem});

  /// What stopped it, in the app's own words and type names only, for the crash report.
  final String problem;

  @override
  String toString() => 'a phone fault: $problem';
}
