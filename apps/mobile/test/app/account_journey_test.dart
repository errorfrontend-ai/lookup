import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

import '../support/expect_no_technical_text.dart';
import 'listener_app_harness.dart';
import 'test_time_clock.dart';

const String _recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

/// The listener account through the whole app (ADR-005; LA-APP-01 to -11): a scan whose result waits for an account,
/// the steps of creating or signing in to one, and the result arriving afterwards. The HTTP transport is the
/// scripted fake; the server's side is proved by the API's own tests.
void main() {
  /// Starts the app and identifies: the API answers `ACCOUNT_REQUIRED`, so the account gate shows.
  Future<ListenerAppHarness> reachTheGate(WidgetTester tester) async {
    final harness = ListenerAppHarness();
    harness.answerWithResponseFixture('valid/account-required');
    await harness.pumpApp(tester, extraOverrides: [clockProvider.overrideWithValue(TestTimeClock(tester))]);
    await tester.tap(find.text('Tap to identify'));
    await harness.pumpTransition(tester);
    await harness.recordWholeClip(tester);
    return harness;
  }

  Future<void> pumpSteps(WidgetTester tester, ListenerAppHarness harness) async {
    await harness.pumpTransition(tester);
    await tester.pump(const Duration(milliseconds: 50));
  }

  Future<void> typeInto(WidgetTester tester, String label, String text) async {
    await tester.enterText(find.widgetWithText(TextField, label), text);
    await tester.pump();
  }

  List<String> pathsOf(ListenerAppHarness harness) => [for (final request in harness.adapter.requests) request.address.path];

  Future<List<HistoryEntry>> historyEntries(ListenerAppHarness harness, WidgetTester tester) async =>
      (await harness.container(tester).read(historyRepositoryProvider).readView()).entries;

  testWidgets('LA-APP-01, -02: an ad whose result waits for an account shows the gate, with nothing of the ad on it', (tester) async {
    final harness = await reachTheGate(tester);
    expect(harness.state(tester), isA<AccountRequiredState>());
    expect(harness.location(tester), '/account');
    expect(find.text('One more step to see your result'), findsOneWidget);
    expect(find.text('Create account'), findsOneWidget);
    expect(find.text('I already have an account'), findsOneWidget);
    expect(find.text('Not now'), findsWidgets);
    expect(find.byType(ResultScreen), findsNothing);
    // None of the ad reached the phone: not its station, advertiser, title or buttons.
    for (final fromTheAd in ['Station A', '98.1 FM', 'Brand A', 'Summer service offer', 'Call us']) {
      expect(find.textContaining(fromTheAd), findsNothing, reason: fromTheAd);
    }
    expectNoTechnicalText(tester);
    // The only request was the clip; the answer held back everything.
    expect(pathsOf(harness), ['/api/v1/recognize']);
  });

  testWidgets('LA-APP-08: Not now goes Home and History keeps a row that reopens the gate for that scan', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.pump(const Duration(milliseconds: 50));
    // The row was saved as the gate showed.
    final waiting = (await historyEntries(harness, tester)).whereType<HistoryAwaitingAccountEntry>().single;
    expect(waiting.entryId, _recognitionId);

    await tester.tap(find.text('Not now').last);
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<IdleState>());
    expect(harness.location(tester), '/');

    await tester.tap(find.text('History'));
    await harness.pumpTransition(tester);
    expect(find.text('Create an account to see this result'), findsOneWidget);
    await tester.tap(find.text('Create an account to see this result'));
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<AccountRequiredState>());
    expect(find.text('One more step to see your result'), findsOneWidget);
    // Not now from History goes back to History.
    await tester.tap(find.text('Not now').last);
    await harness.pumpTransition(tester);
    expect(harness.location(tester), '/history');
  });

  testWidgets('LA-APP-03 to -07: email, code, gender and age, then the result of the same scan', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('Create account'));
    await pumpSteps(tester, harness);
    expect(find.text('Create your account'), findsOneWidget);

    // The email: a slip is told before any request is made.
    await typeInto(tester, 'Email', 'not an email');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);
    expect(find.text('That does not look like an email address. Check it and try again.'), findsOneWidget);
    expect(pathsOf(harness), ['/api/v1/recognize']);

    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', '  Listener@Example.COM ');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);
    expect(harness.adapter.requests.last.address.path, '/api/v1/listener-account/code');
    expect(harness.adapter.requests.last.jsonBody, {'email': 'listener@example.com'});
    expect(harness.adapter.requests.last.header('authorization'), 'Bearer stored.install.token');

    // The code: a code that is not six digits is told at once; the next one is checked by the server.
    expect(find.text('Enter the code'), findsOneWidget);
    expect(find.textContaining('listener@example.com'), findsOneWidget);
    expect(find.textContaining('Send a new code in'), findsOneWidget);
    await typeInto(tester, '6-digit code', '123');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);
    expect(find.text('That code is not right. Check your email and try again.'), findsOneWidget);
    expect(pathsOf(harness).where((path) => path.endsWith('/verify')), isEmpty);

    harness.adapter.answerJson(200, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54});
    await typeInto(tester, '6-digit code', '042817');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);
    expect(harness.adapter.requests.last.address.path, '/api/v1/listener-account/verify');
    expect(harness.adapter.requests.last.jsonBody, {'email': 'listener@example.com', 'code': '042817'});

    // Gender, age and consent: the button waits for all three.
    expect(find.text('About you'), findsOneWidget);
    expect(find.text('A number from 13 to 99'), findsOneWidget);
    FilledButton createButton() => tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Create account'));
    expect(createButton().onPressed, isNull);
    await tester.tap(find.text('Female'));
    await tester.pump();
    await typeInto(tester, 'Your age', '12');
    expect(find.text('You need to be at least 13 to create an account.'), findsOneWidget);
    expect(createButton().onPressed, isNull);
    await typeInto(tester, 'Your age', '30');
    expect(find.text('You need to be at least 13 to create an account.'), findsNothing);
    expect(createButton().onPressed, isNull, reason: 'the consent box is not ticked yet');
    expect(find.text('Tick the box to create your account.'), findsOneWidget);
    await tester.ensureVisible(find.byType(CheckboxListTile));
    await tester.pump();
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pump();
    expect(createButton().onPressed, isNotNull);

    harness.adapter.answerJson(201, {'status': 'SIGNED_IN', 'email_masked': 'l***@example.com'});
    harness.answerWithResponseFixture('valid/match-campaign');
    await tester.tap(find.widgetWithText(FilledButton, 'Create account'));
    await pumpSteps(tester, harness);
    final created = harness.adapter.requests.firstWhere((request) => request.address.path == '/api/v1/listener-account' && request.method == 'POST');
    expect(created.jsonBody, {
      'email': 'listener@example.com',
      'ticket': 'T' * 54,
      'gender': 'FEMALE',
      'age': 30,
      'consent_text_version': 'listener-consent-2026-10',
    });

    // The result of the same scan arrives, as it always would have: the Result screen, saved to History.
    expect(harness.adapter.requests.last.method, 'GET');
    expect(harness.adapter.requests.last.address.path, '/api/v1/recognitions/$_recognitionId');
    expect(harness.adapter.requests.last.header('authorization'), 'Bearer stored.install.token');
    expect(harness.state(tester), isA<MatchedState>());
    expect(harness.location(tester), '/result');
    expect(find.byType(ResultScreen), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 100));
    final entries = await historyEntries(harness, tester);
    expect(entries.whereType<HistoryAwaitingAccountEntry>(), isEmpty, reason: 'the waiting row became the result');
    expect(entries.whereType<HistoryResultEntry>().single.entryId, _recognitionId);
    expectNoTechnicalText(tester);
  });

  testWidgets('LA-APP-07: an email that already has an account signs in and goes straight to the result, with no gender or age asked', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('I already have an account'));
    await pumpSteps(tester, harness);
    expect(find.text('Sign in'), findsOneWidget);

    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', 'returning@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);

    harness.adapter.answerJson(200, {'status': 'SIGNED_IN', 'email_masked': 'r***@example.com'});
    harness.answerWithResponseFixture('valid/match-campaign');
    await typeInto(tester, '6-digit code', '111222');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);

    expect(find.text('About you'), findsNothing);
    expect(harness.state(tester), isA<MatchedState>());
    expect(pathsOf(harness), [
      '/api/v1/recognize',
      '/api/v1/listener-account/code',
      '/api/v1/listener-account/verify',
      '/api/v1/recognitions/$_recognitionId',
    ]);
  });

  testWidgets('LA-APP-06: an ad on several stations shows "Which station?" after the account, and the choice then gives its result', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('I already have an account'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', 'chooser@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(200, {'status': 'SIGNED_IN', 'email_masked': 'c***@example.com'});
    harness.answerWithResponseFixture('valid/choose-station');
    await typeInto(tester, '6-digit code', '444555');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);

    expect(harness.state(tester), isA<ChooseStationState>());
    expect(harness.location(tester), '/choose-station');
    expect(find.text('Which station are you listening to?'), findsOneWidget);
    await tester.tap(find.text('Station B'));
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<MatchedState>());
    // The waiting row became the chosen result.
    final entries = await historyEntries(harness, tester);
    expect(entries.whereType<HistoryAwaitingAccountEntry>(), isEmpty);
    expect(entries.whereType<HistoryResultEntry>().single.entryId, _recognitionId);
  });

  testWidgets('LA-APP-04: wrong, old and locked codes each have their own words, and a new code can be asked for after the minute', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('Create account'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', 'codes@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);

    for (final (code, words) in [
      ('LISTENER_CODE_INCORRECT', 'That code is not right. Check your email and try again.'),
      ('LISTENER_CODE_EXPIRED', 'This code has expired. Ask for a new one.'),
      ('LISTENER_CODE_LOCKED', 'Too many wrong tries. Ask for a new code.'),
    ]) {
      harness.adapter.answerJson(400, {
        'error': {'code': code, 'message': 'The API’s own message that must never be shown.', 'request_id': '1d4e7a0b-3c6f-4e8a-9b5d-6a7b8c9d0e1f'},
      });
      await typeInto(tester, '6-digit code', '123456');
      await tester.tap(find.text('Check the code'));
      await pumpSteps(tester, harness);
      expect(find.text(words), findsOneWidget, reason: code);
      expect(find.textContaining('API’s own message'), findsNothing);
    }

    // Within the minute the button waits; after it, a new code can be asked for.
    expect(find.textContaining('Send a new code in'), findsOneWidget);
    await tester.pump(const Duration(seconds: 61));
    expect(find.text('Send a new code'), findsOneWidget);
    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await tester.tap(find.text('Send a new code'));
    await pumpSteps(tester, harness);
    expect(find.text('A new code is on its way.'), findsOneWidget);
    expect(find.textContaining('Send a new code in'), findsOneWidget);
  });

  testWidgets('LA-APP-10: with no signal at the email step the app says so and nothing is lost', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('Create account'));
    await pumpSteps(tester, harness);
    harness.adapter.failWithDioType(DioExceptionType.connectionError);
    await typeInto(tester, 'Email', 'offline@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);
    expect(find.text('No connection. Check your signal and try again.'), findsOneWidget);
    expect(find.text('Send me a code'), findsOneWidget);
    expectNoTechnicalText(tester);
    // The scan is still waiting, in History, for when the signal returns.
    expect((await historyEntries(harness, tester)).whereType<HistoryAwaitingAccountEntry>(), hasLength(1));
  });

  testWidgets('LA-APP-10: the account is made but the result cannot be fetched: the gate says why and Try again gets it', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('I already have an account'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', 'signal@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);

    harness.adapter.answerJson(200, {'status': 'SIGNED_IN', 'email_masked': 's***@example.com'});
    harness.adapter.failWithDioType(DioExceptionType.connectionError);
    await typeInto(tester, '6-digit code', '222333');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);
    expect(find.text('No connection. Check your signal and try again.'), findsOneWidget);
    expect(harness.state(tester), isA<AccountRequiredState>());

    harness.answerWithResponseFixture('valid/match-campaign');
    await tester.tap(find.text('Try again'));
    await pumpSteps(tester, harness);
    expect(harness.state(tester), isA<MatchedState>());
  });

  testWidgets('a result that is no longer on the server is told, and leads Home', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('I already have an account'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(202, {'resend_after_seconds': 60});
    await typeInto(tester, 'Email', 'gone@example.com');
    await tester.tap(find.text('Send me a code'));
    await pumpSteps(tester, harness);
    harness.adapter.answerJson(200, {'status': 'SIGNED_IN', 'email_masked': 'g***@example.com'});
    harness.answerWithEnvelopeFixture('not-found');
    await typeInto(tester, '6-digit code', '333444');
    await tester.tap(find.text('Check the code'));
    await pumpSteps(tester, harness);
    expect(find.text('We could not find that result any more. Tap Identify to try again.'), findsOneWidget);
    expect(find.text('Try again'), findsNothing);
    await tester.tap(find.text('Back to home'));
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<IdleState>());
  });

  testWidgets('LA-APP-02: Back from the first step returns to the gate, and system Back on the gate is Not now', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.text('Create account'));
    await pumpSteps(tester, harness);
    expect(find.text('Create your account'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Back'));
    await pumpSteps(tester, harness);
    expect(find.text('One more step to see your result'), findsOneWidget);
    expect(harness.state(tester), isA<AccountRequiredState>());
    await tester.binding.handlePopRoute();
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<IdleState>());
    expect(harness.location(tester), '/');
  });

  testWidgets('LA-APP-02: the Close × on the gate is Not now too', (tester) async {
    final harness = await reachTheGate(tester);
    await tester.tap(find.bySemanticsLabel('Not now').first);
    await harness.pumpTransition(tester);
    expect(harness.state(tester), isA<IdleState>());
  });
}
