import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/account_summary.dart';

/// What one call to the listener-account routes came to, read from the HTTP answer or its absence
/// (ADR-005, design §4). Sealed, so every caller handles each kind. Nothing here keeps the API's `message`
/// or an exception's text, so it cannot reach the screen.
sealed class AccountAnswer {
  const AccountAnswer();
}

/// 202: a code was emailed. [resendAfterSeconds] is when another may be asked for.
final class AccountCodeSent extends AccountAnswer {
  const AccountCodeSent({required this.resendAfterSeconds});

  final int resendAfterSeconds;
}

/// 200 or 201 `SIGNED_IN`: this phone now has an account. [emailMasked] is for Settings.
final class AccountSignedIn extends AccountAnswer {
  const AccountSignedIn({required this.emailMasked});

  final String emailMasked;
}

/// 200 `DETAILS_NEEDED`: the code was right for an email with no account yet; [ticket] finishes it.
final class AccountDetailsNeeded extends AccountAnswer {
  const AccountDetailsNeeded({required this.ticket});

  final String ticket;
}

/// 200 to `GET /listener-account`.
final class AccountSummaryRead extends AccountAnswer {
  const AccountSummaryRead(this.summary);

  final AccountSummary summary;
}

/// 204: signed out, or deleted.
final class AccountDone extends AccountAnswer {
  const AccountDone();
}

/// The call did not go through, for [problem]. [retryAfterSeconds] is the wait the server asked for, when it did.
final class AccountRefused extends AccountAnswer {
  const AccountRefused(this.problem, {this.retryAfterSeconds});

  final AccountProblem problem;
  final int? retryAfterSeconds;
}
