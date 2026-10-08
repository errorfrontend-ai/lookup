import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

import '../../../tool/generate_design_tokens.dart' as generator;
import '../../support/repository_file_locator.dart';

/// WCAG 2.2 relative luminance.
double _relativeLuminance(Color colour) {
  double linear(double channel) =>
      channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

/// WCAG 2.2 contrast ratio between two colours, from 1 to 21.
double _contrastRatio(Color first, Color second) {
  final luminances = [_relativeLuminance(first), _relativeLuminance(second)]..sort();
  return (luminances[1] + 0.05) / (luminances[0] + 0.05);
}

typedef _ColourPair = ({
  String what,
  Color Function(LookUpColours colours) foreground,
  Color Function(LookUpColours colours) background,
});

/// Every text-on-background pair the Step 4 screens use (design §2), which must reach 4.5:1.
final List<_ColourPair> _textPairs = [
  (
    what: 'ink text on the page',
    foreground: (colours) => colours.ink,
    background: (colours) => colours.ground,
  ),
  (
    what: 'ink text on a card or panel',
    foreground: (colours) => colours.ink,
    background: (colours) => colours.surface,
  ),
  (
    what: 'muted text on the page',
    foreground: (colours) => colours.muted,
    background: (colours) => colours.ground,
  ),
  (
    what: 'muted text on a card',
    foreground: (colours) => colours.muted,
    background: (colours) => colours.surface,
  ),
  (
    what: 'primary button label',
    foreground: (colours) => colours.onAccent,
    background: (colours) => colours.accent,
  ),
  (
    what: 'tonal button label and numbered badges',
    foreground: (colours) => colours.accentHover,
    background: (colours) => colours.accentSoft,
  ),
  (
    what: 'accent link on the page',
    foreground: (colours) => colours.accent,
    background: (colours) => colours.ground,
  ),
  (
    what: 'accent link on a card',
    foreground: (colours) => colours.accent,
    background: (colours) => colours.surface,
  ),
  (
    what: 'client initial on its round logo',
    foreground: (colours) => colours.surface,
    background: (colours) => colours.ink,
  ),
  (
    what: 'snackbar text',
    foreground: (colours) => colours.surface,
    background: (colours) => colours.ink,
  ),
];

/// Icons and bars that carry meaning, which must reach 3:1 (WCAG non-text contrast).
final List<_ColourPair> _iconPairs = [
  (
    what: 'permission and newer-app icon',
    foreground: (colours) => colours.accent,
    background: (colours) => colours.accentSoft,
  ),
  (
    what: 'no-match icon',
    foreground: (colours) => colours.muted,
    background: (colours) => colours.lineSoft,
  ),
  (
    what: 'no-connection and recording icons',
    foreground: (colours) => colours.ink,
    background: (colours) => colours.lineSoft,
  ),
  (
    what: 'busy icon',
    foreground: (colours) => colours.warning,
    background: (colours) => colours.warningSoft,
  ),
  (
    what: 'failure icon',
    foreground: (colours) => colours.danger,
    background: (colours) => colours.dangerSoft,
  ),
  (
    what: 'permission ticks',
    foreground: (colours) => colours.success,
    background: (colours) => colours.ground,
  ),
  (
    what: 'listening progress',
    foreground: (colours) => colours.accent,
    background: (colours) => colours.lineSoft,
  ),
  (
    what: 'busy progress',
    foreground: (colours) => colours.warning,
    background: (colours) => colours.lineSoft,
  ),
];

void main() {
  final tokensJson = RepositoryFileLocator.file(
    'packages/design-tokens/tokens.json',
  ).readAsStringSync();

  group('drift (S4-THEME-05)', () {
    test('regenerating from tokens.json gives the committed file byte for byte '
        '(run: dart run tool/generate_design_tokens.dart)', () {
      final committed = RepositoryFileLocator.mobileAppFile(
        'lib/core/theme/look_up_tokens.dart',
      ).readAsStringSync();
      expect(committed, generator.generateLookUpTokensSource(tokensJson));
    });

    test('the committed file is marked as generated', () {
      final committed = RepositoryFileLocator.mobileAppFile(
        'lib/core/theme/look_up_tokens.dart',
      ).readAsLinesSync();
      expect(committed.first, generator.generatedFileHeading);
    });

    test('a colour edited in tokens.json without regenerating is caught', () {
      final edited = tokensJson.replaceFirst('"#A8431A"', '"#A8431B"');
      expect(edited, isNot(tokensJson));
      expect(
        generator.generateLookUpTokensSource(edited),
        isNot(generator.generateLookUpTokensSource(tokensJson)),
      );
    });
  });

  group('the generated values match tokens.json', () {
    final tokens = jsonDecode(tokensJson) as Map<String, Object?>;
    final colourModes = tokens['color']! as Map<String, Object?>;
    Color colourFromTokens(String mode, String name) {
      final hexadecimal = (colourModes[mode]! as Map<String, Object?>)[name]! as String;
      return Color(int.parse('FF${hexadecimal.substring(1)}', radix: 16));
    }

    test('the copper accent, in both modes', () {
      expect(LookUpColours.light.accent, colourFromTokens('light', 'accent'));
      expect(LookUpColours.dark.accent, colourFromTokens('dark', 'accent'));
      expect(LookUpColours.light.ink, colourFromTokens('light', 'ink'));
    });

    test('the new type tokens of Step 4', () {
      const type = LookUpTypeStyles.standard;
      expect(type.headline.fontSize, 28);
      expect(type.headline.height! * 28, closeTo(34, 0.0001));
      expect(type.cardTitle.fontSize, 22);
      expect(type.cardTitle.height! * 22, closeTo(28, 0.0001));
      expect(type.cardTitleCompact.fontSize, 20);
      expect(type.cardTitleCompact.height! * 20, closeTo(26, 0.0001));
    });

    test('sizes and durations the design names', () {
      const sizes = LookUpSizes.standard;
      expect(sizes.touchTargetMinimum, 48);
      expect(sizes.touchTargetGapMinimum, 8);
      expect(sizes.bannerAspectRatio, 2);
      const motion = LookUpMotion.standard;
      expect(motion.fast, const Duration(milliseconds: 150));
      expect(motion.base, const Duration(milliseconds: 200));
      expect(motion.slow, const Duration(milliseconds: 300));
      expect(LookUpRadii.standard.medium, 10);
      expect(LookUpSpacing.standard.space6, 24);
    });

    test('no type style names a font family (the system font, S4-THEME-04)', () {
      const type = LookUpTypeStyles.standard;
      for (final style in [
        type.display,
        type.title,
        type.headline,
        type.cardTitle,
        type.cardTitleCompact,
        type.heading,
        type.body,
        type.label,
        type.caption,
      ]) {
        expect(style.fontFamily, isNull);
        expect(style.color, isNull, reason: 'colours come from the colour tokens');
      }
    });
  });

  group('contrast (WCAG AA) in the light theme the app shows', () {
    for (final pair in _textPairs) {
      test('${pair.what} reaches 4.5:1', () {
        const colours = LookUpColours.light;
        expect(
          _contrastRatio(pair.foreground(colours), pair.background(colours)),
          greaterThanOrEqualTo(4.5),
        );
      });
    }
    for (final pair in _iconPairs) {
      test('${pair.what} reaches 3:1', () {
        const colours = LookUpColours.light;
        expect(
          _contrastRatio(pair.foreground(colours), pair.background(colours)),
          greaterThanOrEqualTo(3),
        );
      });
    }
  });

  group('LookUpTokens as a theme extension', () {
    test('copyWith replaces only the groups it is given', () {
      final changed = LookUpTokens.light.copyWith(colours: LookUpColours.dark);
      expect(changed.colours, same(LookUpColours.dark));
      expect(changed.typeStyles, same(LookUpTokens.light.typeStyles));
      expect(changed.spacing, same(LookUpTokens.light.spacing));
      expect(changed.radii, same(LookUpTokens.light.radii));
      expect(changed.sizes, same(LookUpTokens.light.sizes));
      expect(changed.motion, same(LookUpTokens.light.motion));
      expect(LookUpTokens.light.copyWith().colours, same(LookUpColours.light));
    });

    test('lerp blends colours and keeps the other groups', () {
      const light = LookUpTokens.light;
      const dark = LookUpTokens.dark;
      expect(light.lerp(dark, 0).colours.ground, LookUpColours.light.ground);
      expect(light.lerp(dark, 1).colours.ground, LookUpColours.dark.ground);
      expect(
        light.lerp(dark, 0.5).colours.ground,
        Color.lerp(LookUpColours.light.ground, LookUpColours.dark.ground, 0.5),
      );
      expect(light.lerp(dark, 0.5).spacing, same(dark.spacing));
      expect(light.lerp(null, 0.5), same(light));
    });
  });

  group('the generator refuses tokens it cannot use', () {
    Map<String, Object?> decodedTokens() => jsonDecode(tokensJson) as Map<String, Object?>;

    void expectRefused(Map<String, Object?> tokens, String because) {
      expect(
        () => generator.generateLookUpTokensSource(jsonEncode(tokens)),
        throwsFormatException,
        reason: because,
      );
    }

    test('an unknown group, so a new kind of token is never dropped unseen', () {
      expectRefused(decodedTokens()..['shadow'] = <String, Object?>{}, 'shadow');
    });

    test('light and dark colours that do not match', () {
      final tokens = decodedTokens();
      final colours = tokens['color']! as Map<String, Object?>;
      (colours['dark']! as Map<String, Object?>).remove('focus');
      expectRefused(tokens, 'dark has no focus colour');
    });

    test('a colour that is not #RRGGBB', () {
      final tokens = decodedTokens();
      final colours = tokens['color']! as Map<String, Object?>;
      (colours['light']! as Map<String, Object?>)['accent'] = 'copper';
      expectRefused(tokens, 'accent is a word');
    });

    test('a weight Flutter has no constant for', () {
      final tokens = decodedTokens();
      final body = (tokens['type']! as Map<String, Object?>)['body']! as Map<String, Object?>;
      body['weight'] = 450;
      expectRefused(tokens, 'weight 450');
    });

    test('a token name that cannot be a Dart field', () {
      final tokens = decodedTokens();
      (tokens['radius']! as Map<String, Object?>)['extra-large'] = 32;
      expectRefused(tokens, 'extra-large');
    });

    test('a size that is neither a number nor a ratio', () {
      final tokens = decodedTokens();
      (tokens['size']! as Map<String, Object?>)['bannerAspect'] = 'wide';
      expectRefused(tokens, 'bannerAspect wide');
    });

    test('writes a colour with opacity in Flutter order (0xAARRGGBB)', () {
      final tokens = decodedTokens();
      final colours = tokens['color']! as Map<String, Object?>;
      (colours['light']! as Map<String, Object?>)['focus'] = '#1D4ED880';
      expect(
        generator.generateLookUpTokensSource(jsonEncode(tokens)),
        contains('focus: Color(0x801D4ED8)'),
      );
    });
  });
}
