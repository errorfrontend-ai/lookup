import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/identify/presentation/reference_code_panel.dart';
import 'package:lookup_listener/features/identify/presentation/support_chat_button.dart';

import '../../../app/listener_app_harness.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/expect_no_technical_text.dart';
import 'identify_screen_harness.dart';
import '../../../support/english_words.dart';

const String _apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const String _withCode =
    'Please try again. If it keeps happening, share this code with support so we can find the '
    'problem.';

/// One Error variant as design §2.10 draws it.
final class _Variant {
  const _Variant({
    required this.name,
    required this.failure,
    required this.icon,
    required this.heading,
    required this.role,
    required this.explanation,
    required this.code,
    required this.buttons,
  });

  final String name;
  final RecognitionFailure failure;
  final IconData icon;
  final String heading;
  final SemanticsRole role;
  final String explanation;
  final String? code;

  /// The footer's labels, top to bottom.
  final List<String> buttons;
}

const List<_Variant> _variants = [
  _Variant(
    name: 'server failure',
    failure: ServerFailure(requestId: _apiRequestId),
    icon: Icons.warning_amber_rounded,
    heading: 'Something went wrong on our side',
    role: SemanticsRole.alert,
    explanation: _withCode,
    code: '6F1C-2D3E',
    buttons: ['Try again', 'Back to home'],
  ),
  _Variant(
    name: 'phone failure, report sending',
    failure: PhoneFailure(
      reportRequestId: _reportRequestId,
      reportDelivery: ReportDelivery.sending,
    ),
    icon: Icons.warning_amber_rounded,
    heading: 'Something went wrong on our side',
    role: SemanticsRole.alert,
    explanation: 'Please try again.',
    code: null,
    buttons: ['Try again', 'Back to home'],
  ),
  _Variant(
    name: 'phone failure, report accepted',
    failure: PhoneFailure(
      reportRequestId: _reportRequestId,
      reportDelivery: ReportDelivery.accepted,
    ),
    icon: Icons.warning_amber_rounded,
    heading: 'Something went wrong on our side',
    role: SemanticsRole.alert,
    explanation: _withCode,
    code: '0A1B-2C3D',
    buttons: ['Try again', 'Back to home'],
  ),
  _Variant(
    name: 'phone failure, report not accepted',
    failure: PhoneFailure(
      reportRequestId: _reportRequestId,
      reportDelivery: ReportDelivery.notAccepted,
    ),
    icon: Icons.warning_amber_rounded,
    heading: 'Something went wrong on our side',
    role: SemanticsRole.alert,
    explanation: 'Please try again.',
    code: null,
    buttons: ['Try again', 'Back to home'],
  ),
  _Variant(
    name: 'recording unusable',
    failure: RecordingUnusableFailure(requestId: _apiRequestId),
    icon: Icons.mic_off_outlined,
    heading: "We couldn't use that recording",
    role: SemanticsRole.status,
    explanation: 'Please try again, with your phone close to the radio.',
    code: '6F1C-2D3E',
    buttons: ['Try again', 'Back to home'],
  ),
  _Variant(
    name: 'no connection',
    failure: ConnectionFailure(),
    icon: Icons.signal_cellular_off_outlined,
    heading: 'No connection',
    role: SemanticsRole.status,
    explanation:
        "We couldn't reach Look Up. We kept your clip, so you can send it again when you have "
        'signal.',
    code: null,
    buttons: ['Send again', 'Back to home'],
  ),
  _Variant(
    name: 'too many tries, a short wait',
    failure: TooManyTriesFailure(isShortWait: true),
    icon: Icons.schedule,
    heading: 'Too many tries',
    role: SemanticsRole.status,
    explanation: "You've identified a lot in a short time. Please wait a minute, then try again.",
    code: null,
    buttons: ['Back to home'],
  ),
  _Variant(
    name: 'too many tries, a long wait',
    failure: TooManyTriesFailure(isShortWait: false),
    icon: Icons.schedule,
    heading: 'Too many tries',
    role: SemanticsRole.status,
    explanation: 'Please try again later.',
    code: null,
    buttons: ['Back to home'],
  ),
  // Its several-stations wording is gone: CHOOSE_STATION is the chooser (P6 design §2.15).
  _Variant(
    name: 'newer app needed, an answer it cannot show',
    failure: NewerAppNeededFailure(),
    icon: Icons.info_outline,
    heading: 'This needs a newer Look Up',
    role: SemanticsRole.status,
    explanation: "We found an answer this version of the app can't show yet.",
    code: null,
    buttons: ['Back to home'],
  ),
];

/// A production build with a support WhatsApp number (S4-D32).
AppConfiguration _withSupportNumber() => AppConfiguration(
  flavour: AppFlavour.production,
  apiBaseUrl: Uri.parse('https://api.lookup.invalid/api/v1'),
  supportWhatsAppNumber: '+260971234567',
);

/// A development build with the error details flag on.
AppConfiguration _developmentWithDetails() => AppConfiguration(
  flavour: AppFlavour.development,
  apiBaseUrl: Uri.parse('http://10.0.2.2:3999/api/v1'),
  showsErrorDetails: true,
);

/// Each variant's icon colour and circle colour, as design §2.10 lists them (S4-ERROR-03).
final Map<String, ({Color icon, Color circle})> _iconColoursByVariant = {
  'server failure': (icon: LookUpColours.light.danger, circle: LookUpColours.light.dangerSoft),
  'phone failure': (icon: LookUpColours.light.danger, circle: LookUpColours.light.dangerSoft),
  'recording unusable': (icon: LookUpColours.light.ink, circle: LookUpColours.light.lineSoft),
  'no connection': (icon: LookUpColours.light.ink, circle: LookUpColours.light.lineSoft),
  'too many tries': (icon: LookUpColours.light.warning, circle: LookUpColours.light.warningSoft),
  'newer app needed': (icon: LookUpColours.light.accent, circle: LookUpColours.light.accentSoft),
};

IdentifyScreenHarness _harnessFor(RecognitionFailure failure, {AppConfiguration? configuration}) =>
    IdentifyScreenHarness(
      state: ErrorState(failure: failure),
      configuration: configuration,
    );

void main() {
  group('each variant (design §2.10)', () {
    for (final variant in _variants) {
      testWidgets('${variant.name}: wording, icon, role and buttons', (tester) async {
        final semantics = tester.ensureSemantics();
        await _harnessFor(variant.failure).pump(tester, ErrorScreen(failure: variant.failure));

        expect(find.byIcon(variant.icon), findsOneWidget);
        expectStateHeading(tester, variant.heading, variant.role);
        expect(find.text(variant.explanation), findsOneWidget);
        final footerLabels = [
          for (final button in tester.widgetList<ButtonStyleButton>(
            find.byWidgetPredicate(
              (widget) =>
                  (widget is FilledButton || widget is TextButton) &&
                  (widget as ButtonStyleButton).child is Text,
            ),
          ))
            (button.child! as Text).data,
        ].where(['Try again', 'Send again', 'Back to home'].contains).toList();
        expect(footerLabels, variant.buttons);
        if (variant.buttons.length == 1) {
          expect(find.widgetWithText(FilledButton, 'Back to home'), findsOneWidget);
        }
        expect(find.bySemanticsLabel('Close'), findsOneWidget);
        expectNoTechnicalText(tester);
        semantics.dispose();
      });

      testWidgets('${variant.name}: its icon and its circle, in their colours (S4-ERROR-03)', (
        tester,
      ) async {
        await _harnessFor(variant.failure).pump(tester, ErrorScreen(failure: variant.failure));
        final colours = _iconColoursByVariant.entries
            .where((entry) => variant.name.startsWith(entry.key))
            .single
            .value;
        expectStateIcon(
          tester,
          icon: variant.icon,
          iconColour: colours.icon,
          circleColour: colours.circle,
        );
      });

      testWidgets('${variant.name}: a reference code only when support can find it (S4-D9)', (
        tester,
      ) async {
        await _harnessFor(variant.failure).pump(tester, ErrorScreen(failure: variant.failure));
        final code = variant.code;
        if (code == null) {
          expect(find.byType(ReferenceCodePanel), findsNothing);
          expect(find.text('Reference code'), findsNothing);
        } else {
          expect(find.text('Reference code'), findsOneWidget);
          expect(find.text(code), findsOneWidget);
        }
      });
    }
  });

  group('the reference-code panel', () {
    testWidgets('the code from the API id, upper case, in the monospace font', (tester) async {
      await _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
      ).pump(tester, const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)));
      final code = tester.widget<Text>(find.text('6F1C-2D3E'));
      expect(code.style!.fontFamily, 'monospace');
      expect(code.style!.fontWeight, FontWeight.w700);
      expect(code.style!.fontSize, 18);
    });

    testWidgets('"Copy" puts the shown code on the clipboard, then "Code copied" (T40)', (
      tester,
    ) async {
      final harness = _harnessFor(const ServerFailure(requestId: _apiRequestId));
      await harness.pump(
        tester,
        const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)),
      );
      await scrollToAndTap(tester, find.text('Copy'));
      await tester.pump();
      expect(harness.clipboard.copiedTexts, ['6F1C-2D3E']);
      expect(find.text('Code copied'), findsOneWidget);
      expect(harness.flow.calls, isEmpty);
    });
  });

  group('"Message support on WhatsApp" (S4-D32)', () {
    testWidgets('is hidden when the build has no support number (development only)', (
      tester,
    ) async {
      await _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
        configuration: ExampleAppConfigurations.development(),
      ).pump(tester, const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)));
      expect(find.text('Message support on WhatsApp'), findsNothing);
      expect(find.text('Copy'), findsOneWidget);
    });

    for (final variant in _variants) {
      testWidgets('${variant.name}: shown only with a code and a number', (tester) async {
        await _harnessFor(
          variant.failure,
          configuration: _withSupportNumber(),
        ).pump(tester, ErrorScreen(failure: variant.failure));
        expect(
          find.text('Message support on WhatsApp'),
          variant.code == null ? findsNothing : findsOneWidget,
        );
      });
    }

    testWidgets('opens a chat with support carrying the code, through the card builder', (
      tester,
    ) async {
      final harness = _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
        configuration: _withSupportNumber(),
      );
      await harness.pump(
        tester,
        const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)),
      );
      await scrollToAndTap(tester, find.text('Message support on WhatsApp'));
      expect(harness.launcher.openedAddresses, [
        'https://wa.me/260971234567?text=Hello%20Look%20Up%20support%2C%20my%20reference%20code'
            '%20is%206F1C-2D3E.',
      ]);
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('a phone that cannot open it is offered the number to copy', (tester) async {
      final harness = IdentifyScreenHarness(
        state: const ErrorState(failure: ServerFailure(requestId: _apiRequestId)),
        configuration: _withSupportNumber(),
        launcherOpens: false,
      );
      await harness.pump(
        tester,
        const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)),
      );
      await scrollToAndTap(tester, find.byType(SupportChatButton));
      await tester.pumpAndSettle();
      expect(find.text("Couldn't open this"), findsOneWidget);
      expect(find.text('+260 97 123 4567'), findsOneWidget);
      await tester.tap(find.text('Copy number'));
      await tester.pumpAndSettle();
      expect(harness.clipboard.copiedTexts, ['+260971234567']);
    });
  });

  group('development details (S4-ERRORHANDLING-08)', () {
    testWidgets('never in a production build', (tester) async {
      await _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
      ).pump(tester, const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)));
      expect(find.text('Details (development only)'), findsNothing);
    });

    testWidgets('never in a development build without the flag', (tester) async {
      await _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
        configuration: ExampleAppConfigurations.development(),
      ).pump(tester, const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)));
      expect(find.text('Details (development only)'), findsNothing);
    });

    testWidgets('in a development build with the flag, folded until asked for', (tester) async {
      await _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
        configuration: _developmentWithDetails(),
      ).pump(tester, const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)));
      expect(find.text('Details (development only)'), findsOneWidget);
      expect(find.textContaining('ServerFailure'), findsNothing);
      await scrollToAndTap(tester, find.text('Details (development only)'));
      expect(find.textContaining('ServerFailure'), findsOneWidget);
    });
  });

  group('each control calls the flow', () {
    testWidgets('"Try again" calls tryAgain() (T36)', (tester) async {
      final harness = _harnessFor(const ServerFailure(requestId: _apiRequestId));
      await harness.pump(
        tester,
        const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)),
      );
      await scrollToAndTap(tester, find.text('Try again'));
      expect(harness.flow.calls, ['tryAgain']);
    });

    testWidgets('"Send again" calls sendAgain() (T37)', (tester) async {
      final harness = _harnessFor(const ConnectionFailure());
      await harness.pump(tester, const ErrorScreen(failure: ConnectionFailure()));
      await scrollToAndTap(tester, find.text('Send again'));
      expect(harness.flow.calls, ['sendAgain']);
    });

    for (final variant in [_variants.first, _variants[5], _variants[6]]) {
      testWidgets('${variant.name}: "Back to home", Close × and system Back go Home (T38)', (
        tester,
      ) async {
        final harness = _harnessFor(variant.failure);
        await harness.pump(tester, ErrorScreen(failure: variant.failure));
        await scrollToAndTap(tester, find.text('Back to home'));
        await scrollToAndTap(tester, find.byType(ScreenExitButton));
        await pressSystemBack(tester);
        expect(harness.flow.calls, ['backToHome', 'backToHome', 'backToHome']);
      });
    }
  });

  group('with the real flow', () {
    testWidgets('a 500 shows the code made from the id the API echoed, never its message', (
      tester,
    ) async {
      final harness = ListenerAppHarness()..answerWithEnvelopeFixture('internal');
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(harness.location(tester), '/error');

      final requestId = ListenerAppHarness.envelopeRequestId('internal');
      final expectedCode =
          '${requestId.substring(0, 4).toUpperCase()}-${requestId.substring(4, 8).toUpperCase()}';
      expect(find.text(expectedCode), findsOneWidget);
      expect(find.text(englishWords.errorSomethingWentWrongHeading), findsOneWidget);
      expectNoTechnicalText(
        tester,
        alsoForbidden: [ListenerAppHarness.envelopeMessage('internal'), 'INTERNAL', '500'],
      );
    });

    testWidgets('a 400 INVALID_AUDIO shows "We couldn\'t use that recording" with its code', (
      tester,
    ) async {
      final harness = ListenerAppHarness()..answerWithEnvelopeFixture('invalid-audio');
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      expect(find.text("We couldn't use that recording"), findsOneWidget);
      expect(find.text('6C9D-2F7A'), findsOneWidget);
      expectNoTechnicalText(
        tester,
        alsoForbidden: [ListenerAppHarness.envelopeMessage('invalid-audio'), 'INVALID_AUDIO'],
      );
    });

    testWidgets('a recorder that cannot start shows the phone failure with no code yet', (
      tester,
    ) async {
      final harness = ListenerAppHarness();
      harness.recorder.startError = Exception('SocketException: /data/user/0 package:record');
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/error');
      expect(find.text(englishWords.errorSomethingWentWrongHeading), findsOneWidget);
      expect(find.text('Please try again.'), findsOneWidget);
      expect(find.text('Reference code'), findsNothing);
      expectNoTechnicalText(tester);
      expect(harness.reporter.reports, hasLength(1));
    });

    testWidgets('"Try again" after a server failure starts a new listening', (tester) async {
      final harness = ListenerAppHarness()..answerWithEnvelopeFixture('internal');
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      await scrollToAndTap(tester, find.text('Try again'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/listening');
      expect(find.text(englishWords.listeningHeading), findsOneWidget);
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    for (final variant in _variants) {
      testWidgets('${variant.name}: fits at 360 and 320 dp, text scale 1.0 and 2.0', (
        tester,
      ) async {
        await _harnessFor(
          variant.failure,
          configuration: _withSupportNumber(),
        ).expectFitsEveryPhone(tester, ErrorScreen(failure: variant.failure));
      });
    }

    testWidgets('with details open, it still fits', (tester) async {
      final harness = _harnessFor(
        const ServerFailure(requestId: _apiRequestId),
        configuration: _developmentWithDetails(),
      );
      await harness.pump(
        tester,
        const ErrorScreen(failure: ServerFailure(requestId: _apiRequestId)),
      );
      await scrollToAndTap(tester, find.text('Details (development only)'));
      expect(tester.takeException(), isNull);
    });

    for (final variant in [_variants.first, _variants[5], _variants[6]]) {
      testWidgets('${variant.name}: meets the tap target, label and contrast guidelines', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await _harnessFor(
          variant.failure,
          configuration: _withSupportNumber(),
        ).pump(tester, ErrorScreen(failure: variant.failure));
        await expectMeetsTapGuidelines(tester);
        semantics.dispose();
      });
    }
  });
}
