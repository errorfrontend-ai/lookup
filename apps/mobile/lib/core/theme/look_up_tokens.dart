// Generated from packages/design-tokens/tokens.json — do not edit by hand.
// After changing tokens.json, run from apps/mobile:
//   dart run tool/generate_design_tokens.dart
// A test fails while this file and tokens.json disagree (design §3.18, S4-THEME-05), so the
// formatter is kept off: only the generator decides this file's bytes.
// dart format off

import 'package:flutter/material.dart';

/// The design tokens this app shares with the portal, as one theme extension, so no widget holds
/// its own colour, type size, spacing, radius, duration or breakpoint. Widgets read them with
/// `context.lookUpTokens`.
@immutable
class LookUpTokens extends ThemeExtension<LookUpTokens> {
  /// Tokens made of these groups.
  const LookUpTokens({
    required this.colours,
    required this.typeStyles,
    required this.spacing,
    required this.radii,
    required this.sizes,
    required this.motion,
    required this.breakpoints,
  });

  /// The light theme's values.
  static const LookUpTokens light = LookUpTokens(
    colours: LookUpColours.light,
    typeStyles: LookUpTypeStyles.standard,
    spacing: LookUpSpacing.standard,
    radii: LookUpRadii.standard,
    sizes: LookUpSizes.standard,
    motion: LookUpMotion.standard,
    breakpoints: LookUpBreakpoints.standard,
  );

  /// The dark theme's values, shown when the phone is set to dark (P6-THEME-01).
  static const LookUpTokens dark = LookUpTokens(
    colours: LookUpColours.dark,
    typeStyles: LookUpTypeStyles.standard,
    spacing: LookUpSpacing.standard,
    radii: LookUpRadii.standard,
    sizes: LookUpSizes.standard,
    motion: LookUpMotion.standard,
    breakpoints: LookUpBreakpoints.standard,
  );

  final LookUpColours colours;

  final LookUpTypeStyles typeStyles;

  final LookUpSpacing spacing;

  final LookUpRadii radii;

  final LookUpSizes sizes;

  final LookUpMotion motion;

  final LookUpBreakpoints breakpoints;

  @override
  LookUpTokens copyWith({
    LookUpColours? colours,
    LookUpTypeStyles? typeStyles,
    LookUpSpacing? spacing,
    LookUpRadii? radii,
    LookUpSizes? sizes,
    LookUpMotion? motion,
    LookUpBreakpoints? breakpoints,
  }) {
    return LookUpTokens(
      colours: colours ?? this.colours,
      typeStyles: typeStyles ?? this.typeStyles,
      spacing: spacing ?? this.spacing,
      radii: radii ?? this.radii,
      sizes: sizes ?? this.sizes,
      motion: motion ?? this.motion,
      breakpoints: breakpoints ?? this.breakpoints,
    );
  }

  /// Colours blend during a theme change; the other groups are the same in both themes, so they
  /// switch at the halfway point.
  @override
  LookUpTokens lerp(LookUpTokens? other, double t) {
    if (other == null) return this;
    return LookUpTokens(
      colours: LookUpColours.lerp(colours, other.colours, t),
      typeStyles: t < 0.5 ? typeStyles : other.typeStyles,
      spacing: t < 0.5 ? spacing : other.spacing,
      radii: t < 0.5 ? radii : other.radii,
      sizes: t < 0.5 ? sizes : other.sizes,
      motion: t < 0.5 ? motion : other.motion,
      breakpoints: t < 0.5 ? breakpoints : other.breakpoints,
    );
  }
}

/// The one way widgets read the tokens: `context.lookUpTokens.colours.accent`.
extension LookUpTokensOfContext on BuildContext {
  /// The tokens of the nearest theme. `LookUpTheme` always installs them.
  LookUpTokens get lookUpTokens => Theme.of(this).extension<LookUpTokens>()!;
}

/// One mode's colours, named as in tokens.json. The only place the app writes a colour value
/// (S4-THEME-03).
@immutable
class LookUpColours {
  /// Colours made of these values.
  const LookUpColours({
    required this.ground,
    required this.surface,
    required this.ink,
    required this.muted,
    required this.line,
    required this.lineSoft,
    required this.accent,
    required this.accentHover,
    required this.onAccent,
    required this.accentSoft,
    required this.success,
    required this.successSoft,
    required this.warning,
    required this.warningSoft,
    required this.danger,
    required this.dangerSoft,
    required this.focus,
  });

  /// The light mode's colours.
  static const LookUpColours light = LookUpColours(
    ground: Color(0xFFF5F2EE),
    surface: Color(0xFFFFFFFF),
    ink: Color(0xFF1C1917),
    muted: Color(0xFF57534E),
    line: Color(0xFFD6D3D1),
    lineSoft: Color(0xFFE7E2DC),
    accent: Color(0xFFA8431A),
    accentHover: Color(0xFF7C2F10),
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0xFFF6E7DF),
    success: Color(0xFF166534),
    successSoft: Color(0xFFE3F1E7),
    warning: Color(0xFF92400E),
    warningSoft: Color(0xFFFBEFD9),
    danger: Color(0xFFB91C1C),
    dangerSoft: Color(0xFFFBE4E4),
    focus: Color(0xFF1D4ED8),
  );

  /// The dark mode's colours.
  static const LookUpColours dark = LookUpColours(
    ground: Color(0xFF171412),
    surface: Color(0xFF211D1A),
    ink: Color(0xFFF5F2EE),
    muted: Color(0xFFB8B1AA),
    line: Color(0xFF3A3431),
    lineSoft: Color(0xFF2C2724),
    accent: Color(0xFFE07A4F),
    accentHover: Color(0xFFEC9670),
    onAccent: Color(0xFF1C1917),
    accentSoft: Color(0xFF3B2419),
    success: Color(0xFF6FCF8E),
    successSoft: Color(0xFF1B3324),
    warning: Color(0xFFF2B45A),
    warningSoft: Color(0xFF3A2A12),
    danger: Color(0xFFF08A8A),
    dangerSoft: Color(0xFF3D1E1E),
    focus: Color(0xFF93B4FF),
  );

  final Color ground;

  final Color surface;

  final Color ink;

  final Color muted;

  final Color line;

  final Color lineSoft;

  final Color accent;

  final Color accentHover;

  final Color onAccent;

  final Color accentSoft;

  final Color success;

  final Color successSoft;

  final Color warning;

  final Color warningSoft;

  final Color danger;

  final Color dangerSoft;

  final Color focus;

  /// The colours part of the way from [from] to [to], for theme changes.
  static LookUpColours lerp(LookUpColours from, LookUpColours to, double t) {
    return LookUpColours(
      ground: Color.lerp(from.ground, to.ground, t)!,
      surface: Color.lerp(from.surface, to.surface, t)!,
      ink: Color.lerp(from.ink, to.ink, t)!,
      muted: Color.lerp(from.muted, to.muted, t)!,
      line: Color.lerp(from.line, to.line, t)!,
      lineSoft: Color.lerp(from.lineSoft, to.lineSoft, t)!,
      accent: Color.lerp(from.accent, to.accent, t)!,
      accentHover: Color.lerp(from.accentHover, to.accentHover, t)!,
      onAccent: Color.lerp(from.onAccent, to.onAccent, t)!,
      accentSoft: Color.lerp(from.accentSoft, to.accentSoft, t)!,
      success: Color.lerp(from.success, to.success, t)!,
      successSoft: Color.lerp(from.successSoft, to.successSoft, t)!,
      warning: Color.lerp(from.warning, to.warning, t)!,
      warningSoft: Color.lerp(from.warningSoft, to.warningSoft, t)!,
      danger: Color.lerp(from.danger, to.danger, t)!,
      dangerSoft: Color.lerp(from.dangerSoft, to.dangerSoft, t)!,
      focus: Color.lerp(from.focus, to.focus, t)!,
    );
  }
}

/// The type scale. No font family: the app uses the phone's system font (S4-THEME-04), so only
/// size, line height and weight come from the tokens. The line height is shared evenly above and
/// below the text, as CSS does, so text sits where the wireframes draw it.
@immutable
class LookUpTypeStyles {
  /// A group made of these values.
  const LookUpTypeStyles({
    required this.display,
    required this.title,
    required this.headline,
    required this.cardTitle,
    required this.cardTitleCompact,
    required this.heading,
    required this.body,
    required this.label,
    required this.caption,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpTypeStyles standard = LookUpTypeStyles(
    display: TextStyle(
      fontSize: 30,
      height: 36 / 30,
      fontWeight: FontWeight.w700,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    title: TextStyle(
      fontSize: 24,
      height: 30 / 24,
      fontWeight: FontWeight.w700,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    headline: TextStyle(
      fontSize: 28,
      height: 34 / 28,
      fontWeight: FontWeight.w700,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    cardTitle: TextStyle(
      fontSize: 22,
      height: 28 / 22,
      fontWeight: FontWeight.w700,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    cardTitleCompact: TextStyle(
      fontSize: 20,
      height: 26 / 20,
      fontWeight: FontWeight.w700,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    heading: TextStyle(
      fontSize: 18,
      height: 24 / 18,
      fontWeight: FontWeight.w600,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    body: TextStyle(
      fontSize: 16,
      height: 24 / 16,
      fontWeight: FontWeight.w400,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    label: TextStyle(
      fontSize: 14,
      height: 20 / 14,
      fontWeight: FontWeight.w600,
      leadingDistribution: TextLeadingDistribution.even,
    ),
    caption: TextStyle(
      fontSize: 13,
      height: 18 / 13,
      fontWeight: FontWeight.w500,
      leadingDistribution: TextLeadingDistribution.even,
    ),
  );

  final TextStyle display;

  final TextStyle title;

  final TextStyle headline;

  final TextStyle cardTitle;

  final TextStyle cardTitleCompact;

  final TextStyle heading;

  final TextStyle body;

  final TextStyle label;

  final TextStyle caption;
}

/// The spacing scale in logical pixels. `space4` is the token "4": four steps of 4, so 16.
@immutable
class LookUpSpacing {
  /// A group made of these values.
  const LookUpSpacing({
    required this.space1,
    required this.space2,
    required this.space3,
    required this.space4,
    required this.space5,
    required this.space6,
    required this.space8,
    required this.space10,
    required this.space12,
    required this.space14,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpSpacing standard = LookUpSpacing(
    space1: 4,
    space2: 8,
    space3: 12,
    space4: 16,
    space5: 20,
    space6: 24,
    space8: 32,
    space10: 40,
    space12: 48,
    space14: 56,
  );

  final double space1;

  final double space2;

  final double space3;

  final double space4;

  final double space5;

  final double space6;

  final double space8;

  final double space10;

  final double space12;

  final double space14;
}

/// Corner radii in logical pixels (tokens.json's sm, md, lg, xl and pill, in full words).
@immutable
class LookUpRadii {
  /// A group made of these values.
  const LookUpRadii({
    required this.small,
    required this.medium,
    required this.large,
    required this.extraLarge,
    required this.pill,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpRadii standard = LookUpRadii(
    small: 6,
    medium: 10,
    large: 16,
    extraLarge: 24,
    pill: 999,
  );

  final double small;

  final double medium;

  final double large;

  final double extraLarge;

  final double pill;
}

/// Fixed sizes in logical pixels: the smallest tap target, the smallest gap between targets, the
/// station list's row height, and the banner's width divided by its height. The portal's own
/// touch size is left out.
@immutable
class LookUpSizes {
  /// A group made of these values.
  const LookUpSizes({
    required this.touchTargetMinimum,
    required this.touchTargetGapMinimum,
    required this.stationListRowHeight,
    required this.bannerAspectRatio,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpSizes standard = LookUpSizes(
    touchTargetMinimum: 48,
    touchTargetGapMinimum: 8,
    stationListRowHeight: 56,
    bannerAspectRatio: 2 / 1,
  );

  final double touchTargetMinimum;

  final double touchTargetGapMinimum;

  final double stationListRowHeight;

  final double bannerAspectRatio;
}

/// Animation durations. Widgets skip the animation when `MediaQuery.disableAnimations` is set.
@immutable
class LookUpMotion {
  /// A group made of these values.
  const LookUpMotion({
    required this.fast,
    required this.base,
    required this.slow,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpMotion standard = LookUpMotion(
    fast: Duration(milliseconds: 150),
    base: Duration(milliseconds: 200),
    slow: Duration(milliseconds: 300),
  );

  final Duration fast;

  final Duration base;

  final Duration slow;
}

/// The narrowest window, in logical pixels, of each Material window size class (compact, medium,
/// expanded): `WindowSizeClass.of` reads the window's width against them (design §3.19). The
/// portal's own breakpoints are left out.
@immutable
class LookUpBreakpoints {
  /// A group made of these values.
  const LookUpBreakpoints({
    required this.compact,
    required this.medium,
    required this.expanded,
  });

  /// The values in tokens.json, the same in light and dark.
  static const LookUpBreakpoints standard = LookUpBreakpoints(
    compact: 0,
    medium: 600,
    expanded: 840,
  );

  final double compact;

  final double medium;

  final double expanded;
}
