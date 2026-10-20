import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/account_summary.dart';
import 'package:lookup_listener/features/account/presentation/account_settings_screen.dart';

import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../../support/tab_screen_harness.dart';
import '../support/fake_listener_account_repository.dart';

const AccountAnswer _signedIn = AccountSummaryRead(AccountSummary(isSignedIn: true, emailMasked: 'l***@example.com'));
const AccountAnswer _signedOut = AccountSummaryRead(AccountSummary(isSignedIn: false));

/// Settings → Account (ADR-005; LA-APP-11): what this phone's account is, and signing out, deleting and signing in.
void main() {
  late FakeListenerAccountRepository repository;
  var wentBack = 0;

  Future<void> showWith(WidgetTester tester, AccountAnswer describe, {PhoneScreen phoneScreen = PhoneScreen.standard}) async {
    wentBack = 0;
    repository = FakeListenerAccountRepository()..answers['describe'] = () => describe;
    final harness = TabScreenHarness(extraOverrides: [listenerAccountRepositoryProvider.overrideWithValue(repository)]);
    await harness.pump(tester, AccountSettingsScreen(onBack: () => wentBack++), phoneScreen: phoneScreen);
    await tester.pumpAndSettle();
  }

  group('signed in', () {
    testWidgets('says who, with the email masked, and offers Sign out and Delete my account', (tester) async {
      await showWith(tester, _signedIn);
      expect(find.text('Account'), findsOneWidget);
      expect(find.text('Signed in as l***@example.com'), findsOneWidget);
      expect(find.text('Sign out'), findsOneWidget);
      expect(find.text('Delete my account'), findsOneWidget);
      expect(find.text('Create account'), findsNothing);
      expectNoTechnicalText(tester);
    });

    testWidgets('Sign out leaves the account, says so, and reads the state again', (tester) async {
      await showWith(tester, _signedIn);
      repository.answers['signOut'] = () => const AccountDone();
      repository.answers['describe'] = () => _signedOut;
      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();
      expect(repository.calls, ['describe', 'signOut', 'describe']);
      expect(find.text('Signed out.'), findsOneWidget);
      expect(find.text('Create account'), findsOneWidget);
      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('Delete my account asks first: Cancel keeps it, nothing is sent', (tester) async {
      await showWith(tester, _signedIn);
      await tester.tap(find.text('Delete my account'));
      await tester.pumpAndSettle();
      expect(find.text('Delete your account?'), findsOneWidget);
      expect(find.text('This erases your email, gender and age from Look Up. You can create a new account any time.'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(repository.calls, ['describe']);
      expect(find.text('Signed in as l***@example.com'), findsOneWidget);
    });

    testWidgets('Delete confirms, erases, says so, and reads the state again', (tester) async {
      await showWith(tester, _signedIn);
      repository.answers['deleteAccount'] = () => const AccountDone();
      repository.answers['describe'] = () => _signedOut;
      await tester.tap(find.text('Delete my account'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(repository.calls, ['describe', 'deleteAccount', 'describe']);
      expect(find.text('Your account was deleted.'), findsOneWidget);
      expect(find.text('Create account'), findsOneWidget);
    });

    testWidgets('a deletion that fails says why in the app\'s own words and keeps the account shown', (tester) async {
      await showWith(tester, _signedIn);
      repository.answers['deleteAccount'] = () => const AccountRefused(AccountProblem.noConnection);
      await tester.tap(find.text('Delete my account'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(find.text('No connection. Check your signal and try again.'), findsOneWidget);
      expectNoTechnicalText(tester);
    });
  });

  group('signed out', () {
    testWidgets('offers to create an account or sign in', (tester) async {
      await showWith(tester, _signedOut);
      expect(find.text('Create a free account to see the results of the ads you identify, or sign in if you already have one.'), findsOneWidget);
      expect(find.text('Create account'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('Create account opens the steps, and Back returns to the page', (tester) async {
      await showWith(tester, _signedOut);
      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      expect(find.text('Create your account'), findsOneWidget);
      expect(find.text('Send me a code'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pumpAndSettle();
      expect(find.text('Create a free account to see the results of the ads you identify, or sign in if you already have one.'), findsOneWidget);
      expect(wentBack, 0, reason: 'Back inside the steps does not leave the page');
    });

    testWidgets('Sign in opens the same steps with its own heading, and a right code for an existing email shows the signed-in page', (tester) async {
      await showWith(tester, _signedOut);
      await tester.tap(find.text('Sign in').last);
      await tester.pumpAndSettle();
      expect(find.text('Sign in'), findsWidgets);
      repository.answers['requestCode'] = () => const AccountCodeSent(resendAfterSeconds: 60);
      repository.answers['verifyCode'] = () => const AccountSignedIn(emailMasked: 'l***@example.com');
      await tester.enterText(find.byType(TextField), 'listener@example.com');
      await tester.tap(find.text('Send me a code'));
      await tester.pumpAndSettle();
      repository.answers['describe'] = () => _signedIn;
      await tester.enterText(find.byType(TextField), '042817');
      await tester.tap(find.text('Check the code'));
      await tester.pumpAndSettle();
      expect(find.text('Signed in as l***@example.com'), findsOneWidget);
    });
  });

  group('when the account cannot be read', () {
    testWidgets('says so in plain words and offers Try again, which reads it again', (tester) async {
      await showWith(tester, const AccountRefused(AccountProblem.noConnection));
      expect(find.text('We could not check your account right now.'), findsOneWidget);
      expectNoTechnicalText(tester);
      repository.answers['describe'] = () => _signedIn;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Signed in as l***@example.com'), findsOneWidget);
    });

    testWidgets('shows a spinner while it is first read, then the page', (tester) async {
      wentBack = 0;
      repository = FakeListenerAccountRepository();
      final held = Completer<AccountAnswer>();
      repository.held.add(held);
      final harness = TabScreenHarness(extraOverrides: [listenerAccountRepositoryProvider.overrideWithValue(repository)]);
      await harness.pump(tester, AccountSettingsScreen(onBack: () => wentBack++));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      held.complete(_signedOut);
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Create account'), findsOneWidget);
    });
  });

  testWidgets('Back goes back to Settings', (tester) async {
    await showWith(tester, _signedIn);
    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pump();
    expect(wentBack, 1);
  });

  testWidgets('fits a small phone at large text, signed in and signed out, with no overflow (LA-APP-13)', (tester) async {
    for (final describe in [_signedIn, _signedOut]) {
      await showWith(tester, describe, phoneScreen: const PhoneScreen(width: 320, height: 568, textScale: 2.0, devicePixelRatio: 1));
      expect(tester.takeException(), isNull);
    }
  });
}
