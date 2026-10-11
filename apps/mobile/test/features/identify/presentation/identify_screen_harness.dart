import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../../../support/example_app_configurations.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../result/support/fake_action_launcher.dart';
import '../../result/support/fake_clipboard_writer.dart';
import '../../result/support/result_screen_harness.dart' show expectNoClippedText;
import 'recording_recognition_flow.dart';

/// Shows one identify screen the way the app does — in the app's theme, under a `ProviderScope`
/// whose flow records the calls the screen makes, with a fake launcher and clipboard and the
/// configuration the test chooses (production by default) — so a test can check its wording, its
/// semantics, its layout and which flow method each control calls (design §4.3).
final class IdentifyScreenHarness {
  IdentifyScreenHarness({
    RecognitionState state = const IdleState(),
    AppConfiguration? configuration,
    bool launcherOpens = true,
  }) : flow = RecordingRecognitionFlow(state),
       configuration = configuration ?? ExampleAppConfigurations.production(),
       launcher = FakeActionLauncher(opens: launcherOpens);

  final RecordingRecognitionFlow flow;
  final AppConfiguration configuration;
  final FakeActionLauncher launcher;
  final FakeClipboardWriter clipboard = FakeClipboardWriter();

  /// Shows [screen] on [phoneScreen], in the light theme unless [theme] is given.
  Future<void> pump(
    WidgetTester tester,
    Widget screen, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    phoneScreen.applyTo(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          recognitionFlowProvider.overrideWith(() => flow),
          appConfigurationProvider.overrideWithValue(configuration),
          actionLauncherProvider.overrideWithValue(launcher),
          clipboardWriterProvider.overrideWithValue(clipboard),
        ],
        retry: (retryCount, error) => null,
        child: MaterialApp(
          theme: theme ?? LookUpTheme.light(),
          localizationsDelegates: FallbackLocalizations.delegates,
          supportedLocales: FallbackLocalizations.supportedLocales,
          home: screen,
        ),
      ),
    );
  }

  /// Shows [screen] at 360 and 320 dp wide, at text scale 1.0 and 2.0, and fails on any overflow,
  /// any text cut short and any technical text (design §4.3).
  Future<void> expectFitsEveryPhone(WidgetTester tester, Widget screen) async {
    for (final phoneScreen in PhoneScreen.layoutChecks) {
      await pump(tester, screen, phoneScreen: phoneScreen);
      await tester.pump();
      expect(tester.takeException(), isNull, reason: 'on $phoneScreen');
      expectNoClippedText(tester);
      expectNoTechnicalText(tester);
    }
  }
}

/// The tap-target, label and contrast guidelines, at least 8 dp between any two tap targets, and
/// words on every control but Back and Close (design §2.1, §4.3).
Future<void> expectMeetsTapGuidelines(WidgetTester tester) async {
  await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  await expectLater(tester, meetsGuideline(textContrastGuideline));
  expectTapTargetsApart(tester);
  expectEveryControlShowsText(tester);
}

/// Fails when two tap targets on screen overlap or are less than 8 dp apart.
void expectTapTargetsApart(WidgetTester tester) {
  final targets = _tapTargetsOf(tester);
  for (var first = 0; first < targets.length; first++) {
    for (var second = first + 1; second < targets.length; second++) {
      final a = targets[first];
      final b = targets[second];
      final horizontalGap = [b.left - a.right, a.left - b.right].reduce((x, y) => x > y ? x : y);
      final verticalGap = [b.top - a.bottom, a.top - b.bottom].reduce((x, y) => x > y ? x : y);
      final separation = horizontalGap > verticalGap ? horizontalGap : verticalGap;
      expect(
        separation,
        greaterThanOrEqualTo(8 - 0.01),
        reason: 'Tap targets $a and $b are $separation dp apart',
      );
    }
  }
}

/// Fails when a tap target other than the screen's Back arrow or Close × shows no words: every
/// action has a visible text label, and only Back and Close are icon-only, with a screen-reader
/// label instead (design §2.1, S4-USABILITY-01). A screen-reader label alone does not count: the
/// words must be drawn inside the control.
void expectEveryControlShowsText(WidgetTester tester) {
  final exitButtons = find.byType(ScreenExitButton);
  final exitButtonCentres = [
    for (var index = 0; index < exitButtons.evaluate().length; index++)
      tester.getCenter(exitButtons.at(index)),
  ];
  final texts = find.byWidgetPredicate(
    (widget) =>
        widget is Text && (widget.data ?? widget.textSpan?.toPlainText() ?? '').trim().isNotEmpty,
  );
  final textCentres = [
    for (var index = 0; index < texts.evaluate().length; index++) tester.getCenter(texts.at(index)),
  ];
  final targets = _tapTargetsOf(tester);
  expect(targets, isNotEmpty, reason: 'no control on screen to check');
  for (final target in targets) {
    if (exitButtonCentres.any(target.contains)) continue;
    expect(
      textCentres.any(target.contains),
      isTrue,
      reason: 'The control at $target shows no words; only Back and Close may be icon-only',
    );
  }
}

/// Every tap target on screen, in logical pixels from the screen's top left, read from the
/// semantics tree (which the test must have switched on before showing the screen). The tree's root
/// scales to physical pixels, so each rectangle is scaled back by the device pixel ratio.
List<Rect> _tapTargetsOf(WidgetTester tester) {
  final pixelRatio = tester.view.devicePixelRatio;
  final targets = <Rect>[];
  void collect(SemanticsNode node) {
    final data = node.getSemanticsData();
    if (data.hasAction(SemanticsAction.tap) && !node.isMergedIntoParent) {
      final physical = _globalRectOf(node);
      targets.add(
        Rect.fromLTRB(
          physical.left / pixelRatio,
          physical.top / pixelRatio,
          physical.right / pixelRatio,
          physical.bottom / pixelRatio,
        ),
      );
    }
    node.visitChildren((child) {
      collect(child);
      return true;
    });
  }

  // The root of the tree, reached from the screen's own node.
  var root = tester.getSemantics(find.byType(Scaffold).first);
  while (root.parent != null) {
    root = root.parent!;
  }
  collect(root);
  return targets;
}

Rect _globalRectOf(SemanticsNode node) {
  var rect = node.rect;
  SemanticsNode? current = node;
  while (current != null) {
    final transform = current.transform;
    if (transform != null) rect = MatrixUtils.transformRect(transform, rect);
    current = current.parent;
  }
  return rect;
}

/// Scrolls [finder] into view, as a listener would, then taps it: with Flutter's test font, which
/// draws every letter a full square wide, a long screen's footer is below the fold.
Future<void> scrollToAndTap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
}

/// Sends Android's system Back, as the back button or gesture does.
Future<void> pressSystemBack(WidgetTester tester) async {
  final message = const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute'));
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    SystemChannels.navigation.name,
    message,
    (_) {},
  );
  await tester.pump();
}

/// Asks the phone for less motion, as the accessibility setting "Remove animations" does, until
/// the test ends.
void disableAnimations(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(
    disableAnimations: true,
  );
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

/// Checks the screen's round icon as the design draws it (§2.3, §2.8–§2.10): an 88 dp circle filled
/// with [circleColour], holding [icon] at 40 dp in [iconColour]. Widget assertions stand in for the
/// golden images (design §4.3).
void expectStateIcon(
  WidgetTester tester, {
  required IconData icon,
  required Color iconColour,
  required Color circleColour,
}) {
  final circle = find.descendant(
    of: find.byType(StateIconCircle),
    matching: find.byType(DecoratedBox),
  );
  expect(circle, findsOneWidget);
  final decoration = tester.widget<DecoratedBox>(circle).decoration as BoxDecoration;
  expect(decoration.shape, BoxShape.circle);
  expect(decoration.color, circleColour, reason: "the circle's fill");
  expect(tester.getSize(circle), const Size.square(88));
  final drawnIcon = tester.widget<Icon>(find.descendant(of: circle, matching: find.byType(Icon)));
  expect(drawnIcon.icon, icon);
  expect(drawnIcon.color, iconColour, reason: "the icon's colour");
  expect(drawnIcon.size, 40);
}

/// The semantics node of a state heading's live region, whose parent carries its role.
SemanticsNode headingNode(WidgetTester tester, String heading) =>
    tester.getSemantics(find.text(heading));

/// Checks that [heading] is read as a heading, announced as a live region, and sits in a node with
/// [role] (design §2.4 to §2.10).
void expectStateHeading(WidgetTester tester, String heading, SemanticsRole role) {
  final node = headingNode(tester, heading);
  final data = node.getSemanticsData();
  expect(data.label, heading);
  expect(data.flagsCollection.isHeader, isTrue, reason: '"$heading" is not a heading');
  expect(data.flagsCollection.isLiveRegion, isTrue, reason: '"$heading" is not a live region');
  expect(node.parent!.getSemanticsData().role, role);
}
