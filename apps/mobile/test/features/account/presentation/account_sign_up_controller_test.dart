import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_controller.dart';

import '../../../support/fake_clock.dart';
import '../support/fake_listener_account_repository.dart';

/// The sign-up steps (ADR-005, LA-APP-03 to -07): what the phone checks itself, what it asks the server, and where
/// each answer leads.
void main() {
  late FakeListenerAccountRepository repository;
  late FakeClock clock;
  late ProviderContainer container;

  AccountSignUpController controller() => container.read(accountSignUpProvider.notifier);
  AccountSignUpState state() => container.read(accountSignUpProvider);

  setUp(() {
    repository = FakeListenerAccountRepository();
    clock = FakeClock();
    container = ProviderContainer(
      overrides: [
        listenerAccountRepositoryProvider.overrideWithValue(repository),
        accountClockProvider.overrideWithValue(clock),
      ],
    );
    addTearDown(container.dispose);
    // Kept alive for the test, as a screen showing the steps would.
    container.listen(accountSignUpProvider, (previous, next) {});
  });

  group('the email step', () {
    test('a slip is told on the phone, with no request', () async {
      await controller().sendCode('not an email');
      expect(state().problem, AccountProblem.notAnEmail);
      expect(state().step, AccountSignUpStep.email);
      expect(repository.calls, isEmpty);
    });

    test('a good address is sent trimmed and lower-cased, and the code step follows with the wait counted', () async {
      repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
      await controller().sendCode('  Listener@Example.COM ');
      expect(repository.calls, ['requestCode listener@example.com']);
      expect(state().step, AccountSignUpStep.code);
      expect(state().email, 'listener@example.com');
      expect(state().resendAvailableAt, clock.now().add(const Duration(seconds: 60)));
      expect(state().problem, isNull);
      expect(state().isBusy, isFalse);
    });

    test('a refusal stays on the step with its one problem', () async {
      for (final problem in [AccountProblem.noConnection, AccountProblem.tooManyTries, AccountProblem.notAnEmail, AccountProblem.serverFailure]) {
        repository.next = () => AccountRefused(problem);
        await controller().sendCode('listener@example.com');
        expect(state().step, AccountSignUpStep.email, reason: problem.name);
        expect(state().problem, problem);
        expect(state().isBusy, isFalse);
      }
    });

    test('"too soon" means a code is already on its way: the code step opens with the server\'s wait', () async {
      repository.next = () => const AccountRefused(AccountProblem.resendTooSoon, retryAfterSeconds: 37);
      await controller().sendCode('listener@example.com');
      expect(state().step, AccountSignUpStep.code);
      expect(state().resendAvailableAt, clock.now().add(const Duration(seconds: 37)));
      expect(state().problem, isNull);
    });

    test('a second tap while the first is under way asks nothing more', () async {
      final answer = Completer<AccountAnswer>();
      repository.held.add(answer);
      final first = controller().sendCode('listener@example.com');
      expect(state().isBusy, isTrue);
      await controller().sendCode('listener@example.com');
      expect(repository.calls, hasLength(1));
      answer.complete(const AccountCodeSent(resendAfterSeconds: 60));
      await first;
      expect(state().step, AccountSignUpStep.code);
    });

    test('typing again clears the problem', () async {
      await controller().sendCode('nope');
      expect(state().problem, isNotNull);
      controller().clearProblem();
      expect(state().problem, isNull);
    });
  });

  group('the code step', () {
    setUp(() async {
      repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
      await controller().sendCode('listener@example.com');
      repository.calls.clear();
    });

    test('a code that is not six digits is told on the phone, with no request', () async {
      await controller().checkCode('123');
      expect(state().problem, AccountProblem.codeIncorrect);
      expect(repository.calls, isEmpty);
    });

    test('a right code for an email with an account signs in', () async {
      repository.next = () => const AccountSignedIn(emailMasked: 'l***@example.com');
      await controller().checkCode(' 042817 ');
      expect(repository.calls, ['verifyCode listener@example.com 042817']);
      expect(state().isDone, isTrue);
    });

    test('a right code for a new email goes on to gender and age, keeping the ticket', () async {
      repository.next = () => const AccountDetailsNeeded(ticket: 'ticket-value');
      await controller().checkCode('042817');
      expect(state().step, AccountSignUpStep.aboutYou);
      expect(state().ticket, 'ticket-value');
      expect(state().isDone, isFalse);
    });

    test('wrong, old and locked codes stay on the step', () async {
      for (final problem in [AccountProblem.codeIncorrect, AccountProblem.codeExpired, AccountProblem.codeLocked]) {
        repository.next = () => AccountRefused(problem);
        await controller().checkCode('123456');
        expect(state().step, AccountSignUpStep.code);
        expect(state().problem, problem);
      }
    });

    test('a new code can be asked for, and says so; a refusal for being too soon is not shown as a problem', () async {
      repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
      await controller().resendCode();
      expect(state().wasNewCodeSent, isTrue);
      expect(state().problem, isNull);
      repository.next = () => const AccountRefused(AccountProblem.resendTooSoon, retryAfterSeconds: 20);
      await controller().resendCode();
      expect(state().problem, isNull);
      expect(state().resendAvailableAt, clock.now().add(const Duration(seconds: 20)));
    });

    test('"Use a different email" and Back return to the email', () async {
      controller().useDifferentEmail();
      expect(state().step, AccountSignUpStep.email);
    });
  });

  group('gender and age', () {
    setUp(() async {
      repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
      await controller().sendCode('listener@example.com');
      repository.next = () => const AccountDetailsNeeded(ticket: 'ticket-value');
      await controller().checkCode('042817');
      repository.calls.clear();
    });

    test('an age under 13 is told, and nothing is created', () async {
      await controller().createAccount(gender: ListenerGender.female, ageText: '12', hasConsent: true);
      expect(state().problem, AccountProblem.tooYoung);
      expect(repository.calls, isEmpty);
    });

    test('nothing is asked without a gender, a good age and the consent tick', () async {
      await controller().createAccount(gender: null, ageText: '30', hasConsent: true);
      await controller().createAccount(gender: ListenerGender.male, ageText: '', hasConsent: true);
      await controller().createAccount(gender: ListenerGender.male, ageText: '100', hasConsent: true);
      await controller().createAccount(gender: ListenerGender.male, ageText: '30', hasConsent: false);
      expect(repository.calls, isEmpty);
    });

    test('a complete form creates the account with the ticket and the consent wording', () async {
      repository.next = () => const AccountSignedIn(emailMasked: 'l***@example.com');
      await controller().createAccount(gender: ListenerGender.another, ageText: '41', hasConsent: true);
      expect(repository.lastCreation, {
        'email': 'listener@example.com',
        'ticket': 'ticket-value',
        'gender': ListenerGender.another,
        'age': 41,
        'consent': 'listener-consent-2026-10',
      });
      expect(state().isDone, isTrue);
    });

    test('a ticket that timed out sends the listener back to the email with the reason', () async {
      repository.next = () => const AccountRefused(AccountProblem.startAgain);
      await controller().createAccount(gender: ListenerGender.male, ageText: '30', hasConsent: true);
      expect(state().step, AccountSignUpStep.email);
      expect(state().ticket, isNull);
      expect(state().problem, AccountProblem.startAgain);
    });

    test('other refusals stay on the step', () async {
      repository.next = () => const AccountRefused(AccountProblem.alreadySignedIn);
      await controller().createAccount(gender: ListenerGender.male, ageText: '30', hasConsent: true);
      expect(state().step, AccountSignUpStep.aboutYou);
      expect(state().problem, AccountProblem.alreadySignedIn);
    });
  });

  group('Back inside the steps', () {
    test('goes from the code, and from gender and age, to the email; from the email it is the host\'s', () async {
      expect(controller().goBack(), isFalse);
      repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
      await controller().sendCode('listener@example.com');
      expect(controller().goBack(), isTrue);
      expect(state().step, AccountSignUpStep.email);
      await controller().sendCode('listener@example.com');
      repository.next = () => const AccountDetailsNeeded(ticket: 'ticket-value');
      await controller().checkCode('042817');
      expect(controller().goBack(), isTrue);
      expect(state().step, AccountSignUpStep.email);
      expect(state().ticket, isNull);
    });

    test('does nothing while a call is under way', () async {
      final answer = Completer<AccountAnswer>();
      repository.held.add(answer);
      final sending = controller().sendCode('listener@example.com');
      expect(controller().goBack(), isTrue);
      answer.complete(const AccountCodeSent(resendAfterSeconds: 60));
      await sending;
      expect(state().step, AccountSignUpStep.code);
    });
  });

  test('reset starts again from the email', () async {
    repository.next = () => const AccountCodeSent(resendAfterSeconds: 60);
    await controller().sendCode('listener@example.com');
    controller().reset();
    expect(state().step, AccountSignUpStep.email);
    expect(state().email, isEmpty);
  });
}
