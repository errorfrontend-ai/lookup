import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/account_gate_origin.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

import '../../../app/listener_app_harness.dart';
import '../../../support/phone_screen.dart';
import '../../identify/presentation/recording_recognition_flow.dart';

const String openedGateRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

/// The steps of the account gate, in the order a listener meets them.
enum AccountStepNumber {
  /// The gate screen itself.
  gate,

  /// The email.
  email,

  /// The code that came to it.
  code,

  /// Gender, age and the consent tick.
  aboutYou,
}

/// The app showing the account gate (ADR-005), taken to [step] by tapping and typing, with the account routes answered
/// by the harness's fake transport. [keyboardHeight] is how much of the screen's bottom the keyboard covers.
Future<ListenerAppHarness> openAccountStep(
  WidgetTester tester, {
  required AccountStepNumber step,
  PhoneScreen phoneScreen = PhoneScreen.standard,
  double keyboardHeight = 0,
  Brightness brightness = Brightness.light,
}) async {
  tester.platformDispatcher.platformBrightnessTestValue = brightness;
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
  final harness = ListenerAppHarness();
  harness.adapter.answerJson(202, {'resend_after_seconds': 60});
  harness.adapter.answerJson(200, {'status': 'DETAILS_NEEDED', 'ticket': 'T' * 54});
  await harness.pumpApp(
    tester,
    phoneScreen: phoneScreen,
    extraOverrides: [
      recognitionFlowProvider.overrideWith(
        () => RecordingRecognitionFlow(
          const AccountRequiredState(recognitionId: openedGateRecognitionId, origin: AccountGateOrigin.liveIdentify),
        ),
      ),
    ],
  );
  if (keyboardHeight > 0) {
    tester.view.viewInsets = FakeViewPadding(bottom: keyboardHeight);
    addTearDown(tester.view.resetViewInsets);
  }
  await tester.pump(const Duration(milliseconds: 300));
  if (step == AccountStepNumber.gate) return harness;
  await tester.tap(find.text('Create account'));
  await tester.pump(const Duration(milliseconds: 300));
  if (step == AccountStepNumber.email) return harness;
  await tester.enterText(find.byType(TextField), 'listener@example.com');
  await tester.tap(find.text('Send me a code'));
  await harness.pumpTransition(tester);
  if (step == AccountStepNumber.code) return harness;
  await tester.enterText(find.byType(TextField), '042817');
  await tester.tap(find.text('Check the code'));
  await harness.pumpTransition(tester);
  return harness;
}
