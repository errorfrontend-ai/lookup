import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

/// A phone screen size and text scale for widget tests (design §4.3): the wireframes' 360 × 800 dp
/// and the small 320 × 640 dp, each at text scale 1.0 and 2.0. A layout that overflows makes
/// Flutter report an error, which fails the test.
class PhoneScreen {
  const PhoneScreen({required this.width, required this.height, required this.textScale});

  /// Every size and text scale a shared widget must fit.
  static const List<PhoneScreen> layoutChecks = [
    PhoneScreen(width: 360, height: 800, textScale: 1),
    PhoneScreen(width: 360, height: 800, textScale: 2),
    PhoneScreen(width: 320, height: 640, textScale: 1),
    PhoneScreen(width: 320, height: 640, textScale: 2),
  ];

  /// The wireframes' size at normal text.
  static const PhoneScreen standard = PhoneScreen(width: 360, height: 800, textScale: 1);

  /// Logical pixels (dp).
  final double width;
  final double height;
  final double textScale;

  /// A typical phone's pixel density, so drawing is at a realistic resolution.
  static const double _devicePixelRatio = 3;

  /// Sets the test's screen to this size and text scale; both are undone after the test.
  void applyTo(WidgetTester tester) {
    tester.view
      ..devicePixelRatio = _devicePixelRatio
      ..physicalSize = Size(width, height) * _devicePixelRatio;
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  /// Shows [screen] on this phone inside the app's theme and words, as the app would; [theme] is
  /// the light theme unless a test asks for the dark one.
  Future<void> pump(WidgetTester tester, Widget screen, {ThemeData? theme}) async {
    applyTo(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme ?? LookUpTheme.light(),
        localizationsDelegates: FallbackLocalizations.delegates,
        supportedLocales: FallbackLocalizations.supportedLocales,
        home: screen,
      ),
    );
  }

  @override
  String toString() => '${width.round()} × ${height.round()} dp at text scale $textScale';
}
