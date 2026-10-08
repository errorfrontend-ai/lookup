import 'package:flutter/material.dart';

import 'look_up_tokens.dart';

/// Builds the app's Material theme from the generated design tokens (design §3.18, S4-D24), so
/// Material widgets (buttons, snackbars, sheets) already look like the wireframes and screens only
/// add layout.
abstract final class LookUpTheme {
  /// The colour the Material colour scheme is grown from: the brand accent (S4-THEME-01).
  static Color get seedColour => LookUpTokens.light.colours.accent;

  /// The footer's main button is 52 dp tall in the wireframes: 4 dp more than the smallest tap
  /// target. tokens.json has no button-height token, so the height is built from two tokens rather
  /// than written here.
  static double get primaryButtonMinimumHeight =>
      LookUpTokens.light.sizes.touchTargetMinimum + LookUpTokens.light.spacing.space1;

  /// The only theme in Step 4 (`themeMode: ThemeMode.light`); the dark tokens wait for Phase 6.
  ///
  /// `ColorScheme.fromSeed` alone would not give the wireframes' copper, so the token colours are
  /// copied over the colours it grows. No font family is set: the phone's system font is used
  /// (S4-THEME-04).
  static ThemeData light() {
    const tokens = LookUpTokens.light;
    final colours = tokens.colours;
    final typeStyles = tokens.typeStyles;
    final buttonShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(tokens.radii.medium),
    );
    final touchTargetMinimum = tokens.sizes.touchTargetMinimum;
    final primaryButtonSize = Size(touchTargetMinimum, primaryButtonMinimumHeight);
    final primaryButtonLabel = typeStyles.body.copyWith(fontWeight: FontWeight.w700);
    final secondaryButtonLabel = typeStyles.body.copyWith(fontWeight: FontWeight.w600);

    final colourScheme = ColorScheme.fromSeed(seedColor: seedColour).copyWith(
      primary: colours.accent,
      onPrimary: colours.onAccent,
      secondaryContainer: colours.accentSoft,
      onSecondaryContainer: colours.accentHover,
      surface: colours.surface,
      onSurface: colours.ink,
      onSurfaceVariant: colours.muted,
      outline: colours.line,
      outlineVariant: colours.lineSoft,
      error: colours.danger,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: colourScheme,
      scaffoldBackgroundColor: colours.ground,
      // Every control gets at least a 48 × 48 dp tap area, even when it is drawn smaller.
      materialTapTargetSize: MaterialTapTargetSize.padded,
      visualDensity: VisualDensity.standard,
      extensions: const [tokens],
      // Plain Text widgets and Material parts read these, so they match the token scale too.
      textTheme: TextTheme(
        displaySmall: typeStyles.display,
        headlineMedium: typeStyles.headline,
        headlineSmall: typeStyles.title,
        titleLarge: typeStyles.cardTitle,
        titleMedium: typeStyles.heading,
        bodyLarge: typeStyles.body,
        bodyMedium: typeStyles.body,
        bodySmall: typeStyles.caption,
        labelLarge: typeStyles.label,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: primaryButtonSize,
          shape: buttonShape,
          textStyle: primaryButtonLabel,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: primaryButtonSize,
          shape: buttonShape,
          textStyle: primaryButtonLabel,
          foregroundColor: colours.ink,
          backgroundColor: colours.surface,
          side: BorderSide(color: colours.line),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: Size(touchTargetMinimum, touchTargetMinimum),
          shape: buttonShape,
          textStyle: secondaryButtonLabel,
          foregroundColor: colours.ink,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: Size(touchTargetMinimum, touchTargetMinimum),
          foregroundColor: colours.ink,
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: colours.ink,
        contentTextStyle: typeStyles.body.copyWith(color: colours.surface),
      ),
    );
  }
}
