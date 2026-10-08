import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

import '../../support/phone_screen.dart';

void main() {
  final theme = LookUpTheme.light();
  const colours = LookUpColours.light;

  test('uses Material 3 (S4-THEME-01)', () {
    expect(theme.useMaterial3, isTrue);
  });

  test('is grown from the accent token, then takes the exact token colours', () {
    expect(LookUpTheme.seedColour, colours.accent);
    // Colours the theme does not copy over can only match if the seed was the accent.
    final grownFromAccent = ColorScheme.fromSeed(seedColor: colours.accent);
    expect(theme.colorScheme.tertiary, grownFromAccent.tertiary);
    expect(theme.colorScheme.primaryContainer, grownFromAccent.primaryContainer);

    final scheme = theme.colorScheme;
    expect(scheme.primary, colours.accent);
    expect(scheme.onPrimary, colours.onAccent);
    expect(scheme.secondaryContainer, colours.accentSoft);
    expect(scheme.onSecondaryContainer, colours.accentHover);
    expect(scheme.surface, colours.surface);
    expect(scheme.onSurface, colours.ink);
    expect(scheme.onSurfaceVariant, colours.muted);
    expect(scheme.outline, colours.line);
    expect(scheme.outlineVariant, colours.lineSoft);
    expect(scheme.error, colours.danger);
    expect(theme.scaffoldBackgroundColor, colours.ground);
  });

  test('carries the generated tokens for widgets to read', () {
    expect(theme.extension<LookUpTokens>(), same(LookUpTokens.light));
  });

  test('declares no font family, so the phone\'s system font is used (S4-THEME-04)', () {
    final materialDefault = ThemeData(useMaterial3: true);
    expect(
      theme.textTheme.bodyMedium!.fontFamily,
      materialDefault.textTheme.bodyMedium!.fontFamily,
    );
    expect(
      theme.textTheme.headlineMedium!.fontFamily,
      materialDefault.textTheme.headlineMedium!.fontFamily,
    );
  });

  test('plain text uses the body token size', () {
    expect(theme.textTheme.bodyMedium!.fontSize, LookUpTypeStyles.standard.body.fontSize);
  });

  test('pads every tap target to at least 48 × 48 dp', () {
    expect(theme.materialTapTargetSize, MaterialTapTargetSize.padded);
  });

  test('main buttons are 52 dp, text and icon buttons 48 dp, with the md radius', () {
    expect(LookUpTheme.primaryButtonMinimumHeight, 52);
    Size? minimumSizeOf(ButtonStyle? style) => style?.minimumSize?.resolve({});
    expect(minimumSizeOf(theme.filledButtonTheme.style)!.height, 52);
    expect(minimumSizeOf(theme.outlinedButtonTheme.style)!.height, 52);
    expect(minimumSizeOf(theme.textButtonTheme.style)!.height, 48);
    expect(minimumSizeOf(theme.iconButtonTheme.style), const Size(48, 48));
    final shape = theme.filledButtonTheme.style!.shape!.resolve({});
    expect(
      shape,
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(LookUpRadii.standard.medium)),
    );
  });

  testWidgets('buttons drawn in the theme meet those heights', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      Scaffold(
        body: Column(
          children: [
            FilledButton(onPressed: () {}, child: const Text('Try again')),
            OutlinedButton(onPressed: () {}, child: const Text('Cancel')),
            TextButton(onPressed: () {}, child: const Text('Back to home')),
          ],
        ),
      ),
    );
    expect(tester.getSize(find.byType(FilledButton)).height, greaterThanOrEqualTo(52));
    expect(tester.getSize(find.byType(OutlinedButton)).height, greaterThanOrEqualTo(52));
    expect(tester.getSize(find.byType(TextButton)).height, greaterThanOrEqualTo(48));
  });
}
