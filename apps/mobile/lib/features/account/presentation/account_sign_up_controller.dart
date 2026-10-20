import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/account_rules.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';

/// The steps of creating an account or signing in (ADR-005, design §3.1): the email, the code that came to it, and
/// (for an email with no account yet) gender and age.
enum AccountSignUpStep { email, code, aboutYou }

/// Where the sign-up stands. Immutable; the controller makes a new one for each change.
final class AccountSignUpState {
  const AccountSignUpState({
    this.step = AccountSignUpStep.email,
    this.email = '',
    this.ticket,
    this.isBusy = false,
    this.problem,
    this.resendAvailableAt,
    this.wasNewCodeSent = false,
    this.isDone = false,
  });

  final AccountSignUpStep step;

  /// The address typed, trimmed and lower-cased, once a code was asked for.
  final String email;

  /// The ticket a right code for a new email gave; null before.
  final String? ticket;

  /// A call is under way: the step's button waits.
  final bool isBusy;

  /// Why the last try did not go through; null when nothing is wrong.
  final AccountProblem? problem;

  /// When another code may be asked for; null before the first.
  final DateTime? resendAvailableAt;

  /// A new code was asked for and is on its way: the code step says so.
  final bool wasNewCodeSent;

  /// This phone now has an account: the host moves on.
  final bool isDone;

  AccountSignUpState copyWith({
    AccountSignUpStep? step,
    String? email,
    String? ticket,
    bool clearTicket = false,
    bool? isBusy,
    AccountProblem? problem,
    bool clearProblem = false,
    DateTime? resendAvailableAt,
    bool? wasNewCodeSent,
    bool? isDone,
  }) => AccountSignUpState(
    step: step ?? this.step,
    email: email ?? this.email,
    ticket: clearTicket ? null : (ticket ?? this.ticket),
    isBusy: isBusy ?? this.isBusy,
    problem: clearProblem ? null : (problem ?? this.problem),
    resendAvailableAt: resendAvailableAt ?? this.resendAvailableAt,
    wasNewCodeSent: wasNewCodeSent ?? this.wasNewCodeSent,
    isDone: isDone ?? this.isDone,
  );
}

/// Drives the sign-up steps. Each action checks what it can on the phone, then asks the server through the
/// repository, and turns the answer into the next step or one [AccountProblem]. The email, the code, the ticket, the
/// gender and the age live only in this state and the request: nothing is stored or logged.
class AccountSignUpController extends Notifier<AccountSignUpState> {
  @override
  AccountSignUpState build() => const AccountSignUpState();

  ListenerAccountRepository get _repository => ref.read(listenerAccountRepositoryProvider);

  /// Starts again from the email step.
  void reset() => state = const AccountSignUpState();

  /// The email step's button: asks for a code for [typedEmail].
  Future<void> sendCode(String typedEmail) async {
    if (state.isBusy) return;
    if (!AccountRules.looksLikeEmail(typedEmail)) {
      state = state.copyWith(problem: AccountProblem.notAnEmail);
      return;
    }
    final email = AccountRules.normaliseEmail(typedEmail);
    state = state.copyWith(isBusy: true, clearProblem: true);
    final answer = await _repository.requestCode(email);
    if (!ref.mounted) return;
    switch (answer) {
      case AccountCodeSent(:final resendAfterSeconds):
        state = state.copyWith(
          step: AccountSignUpStep.code,
          email: email,
          isBusy: false,
          resendAvailableAt: _now().add(Duration(seconds: resendAfterSeconds)),
          wasNewCodeSent: false,
          clearProblem: true,
        );
      case AccountRefused(problem: AccountProblem.resendTooSoon, :final retryAfterSeconds):
        // A code went to this address a moment ago: it is on its way, so go on to typing it.
        state = state.copyWith(
          step: AccountSignUpStep.code,
          email: email,
          isBusy: false,
          resendAvailableAt: _now().add(Duration(seconds: retryAfterSeconds ?? 60)),
          clearProblem: true,
        );
      case AccountRefused(:final problem):
        state = state.copyWith(isBusy: false, problem: problem);
      default:
        state = state.copyWith(isBusy: false, problem: AccountProblem.serverFailure);
    }
  }

  /// The code step's "Send a new code".
  Future<void> resendCode() async {
    if (state.isBusy || state.step != AccountSignUpStep.code) return;
    state = state.copyWith(isBusy: true, clearProblem: true, wasNewCodeSent: false);
    final answer = await _repository.requestCode(state.email);
    if (!ref.mounted) return;
    switch (answer) {
      case AccountCodeSent(:final resendAfterSeconds):
        state = state.copyWith(
          isBusy: false,
          resendAvailableAt: _now().add(Duration(seconds: resendAfterSeconds)),
          wasNewCodeSent: true,
        );
      case AccountRefused(:final problem, :final retryAfterSeconds):
        state = state.copyWith(
          isBusy: false,
          problem: problem == AccountProblem.resendTooSoon ? null : problem,
          resendAvailableAt: problem == AccountProblem.resendTooSoon
              ? _now().add(Duration(seconds: retryAfterSeconds ?? 60))
              : null,
        );
      default:
        state = state.copyWith(isBusy: false, problem: AccountProblem.serverFailure);
    }
  }

  /// The code step's button: checks [typedCode]. A right code for an email with an account signs in; for a new
  /// email it goes on to gender and age.
  Future<void> checkCode(String typedCode) async {
    if (state.isBusy || state.step != AccountSignUpStep.code) return;
    if (!AccountRules.isCompleteCode(typedCode.trim())) {
      state = state.copyWith(problem: AccountProblem.codeIncorrect);
      return;
    }
    state = state.copyWith(isBusy: true, clearProblem: true, wasNewCodeSent: false);
    final answer = await _repository.verifyCode(email: state.email, code: typedCode.trim());
    if (!ref.mounted) return;
    switch (answer) {
      case AccountSignedIn():
        state = state.copyWith(isBusy: false, isDone: true);
      case AccountDetailsNeeded(:final ticket):
        state = state.copyWith(step: AccountSignUpStep.aboutYou, ticket: ticket, isBusy: false);
      case AccountRefused(:final problem):
        state = state.copyWith(isBusy: false, problem: problem);
      default:
        state = state.copyWith(isBusy: false, problem: AccountProblem.serverFailure);
    }
  }

  /// The last step's button: creates the account. The button is not available without a gender, a consent tick and
  /// an age the form accepts; the age is checked here again.
  Future<void> createAccount({
    required ListenerGender? gender,
    required String ageText,
    required bool hasConsent,
  }) async {
    final ticket = state.ticket;
    if (state.isBusy || state.step != AccountSignUpStep.aboutYou || ticket == null) return;
    final age = AccountRules.readAge(ageText);
    if (gender == null || age == null || !hasConsent) return;
    if (!AccountRules.isOldEnough(age)) {
      state = state.copyWith(problem: AccountProblem.tooYoung);
      return;
    }
    state = state.copyWith(isBusy: true, clearProblem: true);
    final answer = await _repository.createAccount(
      email: state.email,
      ticket: ticket,
      gender: gender,
      age: age,
      consentTextVersion: AccountRules.consentTextVersion,
    );
    if (!ref.mounted) return;
    switch (answer) {
      case AccountSignedIn():
        state = state.copyWith(isBusy: false, isDone: true);
      case AccountRefused(problem: AccountProblem.startAgain):
        state = state.copyWith(
          step: AccountSignUpStep.email,
          clearTicket: true,
          isBusy: false,
          problem: AccountProblem.startAgain,
        );
      case AccountRefused(:final problem):
        state = state.copyWith(isBusy: false, problem: problem);
      default:
        state = state.copyWith(isBusy: false, problem: AccountProblem.serverFailure);
    }
  }

  /// "Use a different email", and Back from the code step: to the email step.
  void useDifferentEmail() => state = state.copyWith(
    step: AccountSignUpStep.email,
    clearTicket: true,
    clearProblem: true,
    wasNewCodeSent: false,
  );

  /// Back inside the steps: from gender and age or the code to the email. Returns false on the email step, where the
  /// host's own Back (to "Not now", or to Settings) applies.
  bool goBack() {
    if (state.isBusy) return true;
    if (state.step == AccountSignUpStep.email) return false;
    useDifferentEmail();
    return true;
  }

  /// A problem the listener has read, once they start typing again.
  void clearProblem() {
    if (state.problem != null) state = state.copyWith(clearProblem: true);
  }

  DateTime _now() => ref.read(accountClockProvider).now();
}

/// The sign-up steps. Discarded when no screen shows them, so a new gate always starts at the email.
final NotifierProvider<AccountSignUpController, AccountSignUpState> accountSignUpProvider =
    NotifierProvider.autoDispose<AccountSignUpController, AccountSignUpState>(
      AccountSignUpController.new,
      retry: (retryCount, error) => null,
    );
