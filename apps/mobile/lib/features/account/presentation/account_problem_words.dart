import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The app's own words for each [AccountProblem] (ADR-005, design §3.1): never the server's.
abstract final class AccountProblemWords {
  static String of(AccountProblem problem, AppLocalizations words) => switch (problem) {
    AccountProblem.notAnEmail => words.accountProblemNotAnEmail,
    AccountProblem.noConnection => words.accountProblemNoConnection,
    AccountProblem.tooManyTries || AccountProblem.resendTooSoon => words.accountProblemTooManyTries,
    AccountProblem.codeIncorrect => words.accountProblemCodeIncorrect,
    AccountProblem.codeExpired => words.accountProblemCodeExpired,
    AccountProblem.codeLocked => words.accountProblemCodeLocked,
    AccountProblem.startAgain => words.accountProblemStartAgain,
    AccountProblem.tooYoung => words.accountProblemTooYoung,
    AccountProblem.alreadySignedIn => words.accountProblemAlreadySignedIn,
    AccountProblem.updateRequired => words.accountProblemUpdateRequired,
    AccountProblem.serverFailure => words.accountProblemServerFailure,
  };
}
