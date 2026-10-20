import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/network/retry_after.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/account_summary.dart';

/// Reads the answers of the listener-account routes (ADR-005, design §4). Strict where the screen needs something,
/// and it never reads the error's `message`, so the app can only show its own words. Never throws.
final class AccountResponseParser {
  const AccountResponseParser();

  static final RegExp _errorCode = RegExp(r'^[A-Z][A-Z0-9_]{1,63}$');

  /// The answer to asking for a code: 202 with the wait before another.
  AccountAnswer readCodeSent(ApiAnswer answer, {required DateTime now}) => _read(
    answer,
    now: now,
    onSuccess: (status, body) {
      if (status != 202 || body is! Map<Object?, Object?>) return null;
      final resendAfter = body['resend_after_seconds'];
      return resendAfter is int && resendAfter >= 1 && resendAfter <= 3600
          ? AccountCodeSent(resendAfterSeconds: resendAfter)
          : null;
    },
  );

  /// The answer to a code check: signed in, or the ticket for finishing a new account.
  AccountAnswer readVerified(ApiAnswer answer, {required DateTime now}) => _read(
    answer,
    now: now,
    onSuccess: (status, body) {
      if (status != 200 || body is! Map<Object?, Object?>) return null;
      return switch (body['status']) {
        'SIGNED_IN' => _signedIn(body),
        'DETAILS_NEEDED' => switch (body['ticket']) {
          final String ticket when ticket.isNotEmpty && ticket.length <= 300 => AccountDetailsNeeded(
            ticket: ticket,
          ),
          _ => null,
        },
        _ => null,
      };
    },
  );

  /// The answer to creating the account: 201 signed in.
  AccountAnswer readCreated(ApiAnswer answer, {required DateTime now}) => _read(
    answer,
    now: now,
    onSuccess: (status, body) {
      if (status != 201 || body is! Map<Object?, Object?> || body['status'] != 'SIGNED_IN') return null;
      return _signedIn(body);
    },
  );

  /// The answer to Settings' question: signed in or not.
  AccountAnswer readSummary(ApiAnswer answer, {required DateTime now}) => _read(
    answer,
    now: now,
    onSuccess: (status, body) {
      if (status != 200 || body is! Map<Object?, Object?>) return null;
      final isSignedIn = body['is_signed_in'];
      final emailMasked = body['email_masked'];
      if (isSignedIn is! bool) return null;
      if (!isSignedIn) return const AccountSummaryRead(AccountSummary(isSignedIn: false));
      return emailMasked is String && emailMasked.isNotEmpty
          ? AccountSummaryRead(AccountSummary(isSignedIn: true, emailMasked: emailMasked))
          : null;
    },
  );

  /// The answer to signing out or deleting: 204.
  AccountAnswer readNoContent(ApiAnswer answer, {required DateTime now}) =>
      _read(answer, now: now, onSuccess: (status, body) => status == 204 ? const AccountDone() : null);

  /// A registration that failed before the call could be made, read as any call's failure is.
  AccountAnswer readNotRegistered(ApiAnswer answer, {required DateTime now}) =>
      _read(answer, now: now, onSuccess: (status, body) => null);

  static AccountAnswer? _signedIn(Map<Object?, Object?> body) {
    final emailMasked = body['email_masked'];
    return emailMasked is String && emailMasked.isNotEmpty ? AccountSignedIn(emailMasked: emailMasked) : null;
  }

  AccountAnswer _read(
    ApiAnswer answer, {
    required DateTime now,
    required AccountAnswer? Function(int status, Object? body) onSuccess,
  }) {
    switch (answer) {
      case ApiAnswerNotReceived(:final reason):
        return switch (reason) {
          ApiNoAnswerReason.noConnection ||
          ApiNoAnswerReason.timedOut ||
          ApiNoAnswerReason.connectionDropped => const AccountRefused(AccountProblem.noConnection),
          ApiNoAnswerReason.cancelled ||
          ApiNoAnswerReason.plainHttpRefused ||
          ApiNoAnswerReason.unexpectedFailure => const AccountRefused(AccountProblem.serverFailure),
        };
      case ApiAnswerReceived(:final status, :final body, :final retryAfter):
        final json = switch (body) {
          JsonAnswerBody(:final value) => value,
          NotJsonAnswerBody() => null,
        };
        if (status >= 200 && status < 300) {
          return onSuccess(status, json) ?? const AccountRefused(AccountProblem.serverFailure);
        }
        final errorCode = _errorCodeOf(json);
        final retryAfterSeconds = RetryAfter.parse(retryAfter, now: now)?.inSeconds;
        final problem = switch ((status, errorCode)) {
          (400, 'LISTENER_CODE_INCORRECT') => AccountProblem.codeIncorrect,
          (400, 'LISTENER_CODE_EXPIRED') => AccountProblem.codeExpired,
          (400, 'LISTENER_CODE_LOCKED') => AccountProblem.codeLocked,
          (400, 'ACCOUNT_TICKET_NOT_VALID') => AccountProblem.startAgain,
          (400, 'VALIDATION_FAILED') when _refusesTheEmail(json) => AccountProblem.notAnEmail,
          (422, 'ACCOUNT_AGE_TOO_YOUNG') => AccountProblem.tooYoung,
          (409, 'ALREADY_SIGNED_IN') => AccountProblem.alreadySignedIn,
          (429, 'RESEND_TOO_SOON') => AccountProblem.resendTooSoon,
          (429, _) => AccountProblem.tooManyTries,
          (426, _) => AccountProblem.updateRequired,
          _ => AccountProblem.serverFailure,
        };
        return AccountRefused(problem, retryAfterSeconds: retryAfterSeconds);
    }
  }

  static String? _errorCodeOf(Object? json) {
    if (json is! Map<Object?, Object?>) return null;
    final envelope = json['error'];
    if (envelope is! Map<Object?, Object?>) return null;
    final code = envelope['code'];
    return code is String && _errorCode.hasMatch(code) ? code : null;
  }

  /// Whether the error envelope names the `email` field among those it refused.
  static bool _refusesTheEmail(Object? json) {
    if (json is! Map<Object?, Object?>) return false;
    final envelope = json['error'];
    final fields = envelope is Map<Object?, Object?> ? envelope['fields'] : null;
    if (fields is! List<Object?>) return false;
    return fields.any((field) => field is Map<Object?, Object?> && field['path'] == 'email');
  }
}
