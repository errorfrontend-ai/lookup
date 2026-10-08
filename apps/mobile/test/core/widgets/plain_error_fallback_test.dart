import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/widgets/plain_error_fallback.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';

import '../../support/expect_no_technical_text.dart';
import '../../support/phone_screen.dart';

/// An exception full of the things a listener must never see.
final StateError _hostileError = StateError(
  'SocketException: Connection refused at package:lookup_listener/secret.dart '
  '/data/user/0/zm.lookup.listener/cache SQLSTATE 42P01',
);

/// A widget that fails to build, like a bug in a screen would.
class _FailingPart extends StatelessWidget {
  const _FailingPart();

  @override
  Widget build(BuildContext context) => throw _hostileError;
}

/// An exception whose own description fails.
class _UndescribableException implements Exception {
  @override
  String toString() => throw StateError('cannot describe');
}

/// Shows a screen with a failing part, with `ErrorWidget.builder` set as the app sets it, and puts
/// Flutter's builder back before the test ends (the test framework checks it was restored).
Future<void> _pumpFailingScreen(
  WidgetTester tester, {
  required bool showsErrorDetails,
  PhoneScreen screen = PhoneScreen.standard,
}) async {
  final flutterBuilder = ErrorWidget.builder;
  ErrorWidget.builder = (details) =>
      PlainErrorFallback(errorDetails: details, showsErrorDetails: showsErrorDetails);
  try {
    await screen.pump(
      tester,
      const ScreenFrame(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [Text('Heard an ad on the radio?'), _FailingPart()],
        ),
      ),
    );
  } finally {
    ErrorWidget.builder = flutterBuilder;
  }
  // The build failure is reported (in the app, by FlutterError.onError); take it so it does not
  // fail the test, and check it was the one thrown.
  expect(tester.takeException(), same(_hostileError));
}

void main() {
  testWidgets('a part that fails to build shows the plain words and no exception text', (
    tester,
  ) async {
    await _pumpFailingScreen(tester, showsErrorDetails: false);

    expect(find.text(PlainErrorFallback.message), findsOneWidget);
    expect(find.text("This part couldn't be shown."), findsOneWidget);
    expect(
      find.text('Heard an ad on the radio?'),
      findsOneWidget,
      reason: 'the rest of the screen still shows',
    );
    expectNoTechnicalText(tester);
    expect(find.textContaining('Connection refused'), findsNothing);
  });

  testWidgets('a development build with the details flag shows the error text instead', (
    tester,
  ) async {
    await _pumpFailingScreen(tester, showsErrorDetails: true);

    expect(find.textContaining('SocketException: Connection refused'), findsOneWidget);
    expect(find.text(PlainErrorFallback.message), findsNothing);
  });

  testWidgets('an exception that cannot describe itself still gets the plain words', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlainErrorFallback(
            errorDetails: FlutterErrorDetails(exception: _UndescribableException()),
            showsErrorDetails: true,
          ),
        ),
      ),
    );
    expect(find.text(PlainErrorFallback.message), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('works with no app, theme or text direction above it', (tester) async {
    await tester.pumpWidget(
      PlainErrorFallback(errorDetails: FlutterErrorDetails(exception: _hostileError)),
    );
    expect(tester.takeException(), isNull);
    expect(find.text(PlainErrorFallback.message), findsOneWidget);
  });

  testWidgets('fits a tiny space without an overflow error of its own', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Center(
          child: SizedBox(
            width: 40,
            height: 20,
            child: PlainErrorFallback(errorDetails: FlutterErrorDetails(exception: _hostileError)),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
  });

  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $screen', (tester) async {
      await _pumpFailingScreen(tester, showsErrorDetails: false, screen: screen);
      expect(find.text(PlainErrorFallback.message), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
