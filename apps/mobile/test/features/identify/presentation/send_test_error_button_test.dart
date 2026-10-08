import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';

import '../../../support/phone_screen.dart';

void main() {
  testWidgets('"Send a test error" throws on purpose, and Flutter hands the throw on', (
    tester,
  ) async {
    await PhoneScreen.standard.pump(tester, const Scaffold(body: SendTestErrorButton()));
    expect(find.widgetWithText(TextButton, 'Send a test error'), findsOneWidget);

    await tester.tap(find.text('Send a test error'));
    // The throw reached FlutterError.onError, where the app's global handler reports it.
    final thrown = tester.takeException();
    expect(thrown, isA<StateError>());
    expect('$thrown', contains('A test error, thrown on purpose from the developer tools'));
  });
}
