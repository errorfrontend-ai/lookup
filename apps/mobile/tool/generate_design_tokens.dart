// Turns packages/design-tokens/tokens.json into lib/core/theme/look_up_tokens.dart, the app's
// `LookUpTokens` theme extension, so the app and the portal take their colours, type scale, spacing,
// radii, sizes and durations from one file (design §3.18, S4-THEME-02). Run from apps/mobile after
// changing tokens.json:
//
//   dart run tool/generate_design_tokens.dart
//
// test/core/theme/look_up_tokens_test.dart runs `generateLookUpTokensSource` on tokens.json and fails
// while the committed file differs (S4-THEME-05). Only `dart:` libraries are used, so this runs
// without Flutter and without a download.

import 'dart:convert';
import 'dart:io';

/// The first line of the generated file.
const String generatedFileHeading =
    '// Generated from packages/design-tokens/tokens.json — do not edit by hand.';

/// The groups of tokens.json the generator turns into Dart.
const Set<String> _readGroups = {'color', 'type', 'space', 'radius', 'size', 'motion'};

/// Groups of tokens.json the app does not read: `meta` is notes, `font` names web fonts (the app
/// uses the phone's system font, S4-THEME-04), and `breakpoint` has no use before Phase 6. Any other
/// unknown group stops the generator, so a new kind of token is never dropped unseen.
const Set<String> _ignoredGroups = {'meta', 'font', 'breakpoint'};

/// tokens.json keys that are abbreviations, and the full-word names the app uses for them.
const Map<String, String> _radiusNames = {
  'sm': 'small',
  'md': 'medium',
  'lg': 'large',
  'xl': 'extraLarge',
};
const Map<String, String> _sizeNames = {
  'touchMinApp': 'touchTargetMinimum',
  'touchGapMin': 'touchTargetGapMinimum',
  'listRowStation': 'stationListRowHeight',
  'bannerAspect': 'bannerAspectRatio',
};

/// Sizes meant only for the portal.
const Set<String> _webOnlySizes = {'touchMinWeb'};

/// Motion settings that are not durations: the app always honours the phone's "remove animations"
/// setting through `MediaQuery.disableAnimations`, so this flag needs no field.
const Set<String> _motionSettingsWithoutDuration = {'respectReducedMotion'};

/// The groups of `LookUpTokens`, in order, with their types.
const Map<String, String> _tokenGroups = {
  'colours': 'LookUpColours',
  'typeStyles': 'LookUpTypeStyles',
  'spacing': 'LookUpSpacing',
  'radii': 'LookUpRadii',
  'sizes': 'LookUpSizes',
  'motion': 'LookUpMotion',
};

final RegExp _fieldNamePattern = RegExp(r'^[a-z][A-Za-z0-9]*$');
final RegExp _spacingStepPattern = RegExp(r'^[1-9][0-9]*$');
final RegExp _hexColourPattern = RegExp(r'^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$');
final RegExp _aspectRatioPattern = RegExp(r'^([1-9][0-9]*):([1-9][0-9]*)$');

/// Builds the Dart source of look_up_tokens.dart from the text of tokens.json. Pure (no files, no
/// clock), so the drift test can compare its answer with the committed file byte for byte. Throws a
/// [FormatException] naming the token when tokens.json has a shape the app cannot use.
String generateLookUpTokensSource(String tokensJson) {
  final tokens = _readObject(jsonDecode(tokensJson), 'tokens.json');
  for (final group in tokens.keys) {
    if (!_readGroups.contains(group) && !_ignoredGroups.contains(group)) {
      throw FormatException(
        'tokens.json has a group "$group" the app generator does not know; '
        'add it to tool/generate_design_tokens.dart',
      );
    }
  }

  final colourModes = _readObject(tokens['color'], 'color');
  final lightColours = _readColours(colourModes['light'], 'color.light');
  final darkColours = _readColours(colourModes['dark'], 'color.dark');
  if (lightColours.keys.join(',') != darkColours.keys.join(',')) {
    throw const FormatException(
      'color.light and color.dark must name the same colours in the same order',
    );
  }

  final typeStyles = <String, String>{};
  _readObject(tokens['type'], 'type').forEach((name, value) {
    final path = 'type.$name';
    typeStyles[_checkFieldName(name, path)] = _textStyleSource(_readObject(value, path), path);
  });

  final spacing = <String, String>{};
  _readObject(tokens['space'], 'space').forEach((step, value) {
    if (!_spacingStepPattern.hasMatch(step)) {
      throw FormatException('space.$step: a step must be a whole number');
    }
    spacing['space$step'] = _numberSource(value, 'space.$step');
  });

  final radii = <String, String>{};
  _readObject(tokens['radius'], 'radius').forEach((name, value) {
    final path = 'radius.$name';
    radii[_checkFieldName(_radiusNames[name] ?? name, path)] = _numberSource(value, path);
  });

  final sizes = <String, String>{};
  _readObject(tokens['size'], 'size').forEach((name, value) {
    if (_webOnlySizes.contains(name)) return;
    final path = 'size.$name';
    sizes[_checkFieldName(_sizeNames[name] ?? name, path)] = value is String
        ? _aspectRatioSource(value, path)
        : _numberSource(value, path);
  });

  final motion = <String, String>{};
  _readObject(tokens['motion'], 'motion').forEach((name, value) {
    if (_motionSettingsWithoutDuration.contains(name)) return;
    final path = 'motion.$name';
    motion[_checkFieldName(name, path)] = 'Duration(milliseconds: ${_numberSource(value, path)})';
  });

  return [
    _fileStartSource,
    _tokensClassSource(),
    _contextExtensionSource,
    _coloursClassSource(lightColours, darkColours),
    _constantGroupSource(
      className: 'LookUpTypeStyles',
      documentation: '''
/// The type scale. No font family: the app uses the phone's system font (S4-THEME-04), so only
/// size, line height and weight come from the tokens. The line height is shared evenly above and
/// below the text, as CSS does, so text sits where the wireframes draw it.
''',
      fieldType: 'TextStyle',
      values: typeStyles,
    ),
    _constantGroupSource(
      className: 'LookUpSpacing',
      documentation: '''
/// The spacing scale in logical pixels. `space4` is the token "4": four steps of 4, so 16.
''',
      fieldType: 'double',
      values: spacing,
    ),
    _constantGroupSource(
      className: 'LookUpRadii',
      documentation: '''
/// Corner radii in logical pixels (tokens.json's sm, md, lg, xl and pill, in full words).
''',
      fieldType: 'double',
      values: radii,
    ),
    _constantGroupSource(
      className: 'LookUpSizes',
      documentation: '''
/// Fixed sizes in logical pixels: the smallest tap target, the smallest gap between targets, the
/// station list's row height, and the banner's width divided by its height. The portal's own
/// touch size is left out.
''',
      fieldType: 'double',
      values: sizes,
    ),
    _constantGroupSource(
      className: 'LookUpMotion',
      documentation: '''
/// Animation durations. Widgets skip the animation when `MediaQuery.disableAnimations` is set.
''',
      fieldType: 'Duration',
      values: motion,
    ),
  ].join('\n');
}

const String _fileStartSource =
    '''
$generatedFileHeading
// After changing tokens.json, run from apps/mobile:
//   dart run tool/generate_design_tokens.dart
// A test fails while this file and tokens.json disagree (design §3.18, S4-THEME-05), so the
// formatter is kept off: only the generator decides this file's bytes.
// dart format off

import 'package:flutter/material.dart';
''';

const String _contextExtensionSource = '''
/// The one way widgets read the tokens: `context.lookUpTokens.colours.accent`.
extension LookUpTokensOfContext on BuildContext {
  /// The tokens of the nearest theme. `LookUpTheme` always installs them.
  LookUpTokens get lookUpTokens => Theme.of(this).extension<LookUpTokens>()!;
}
''';

String _tokensClassSource() {
  String eachGroup(String Function(String field, String type) line) =>
      _tokenGroups.entries.map((group) => line(group.key, group.value)).join();
  String tokensConstant(String mode) =>
      eachGroup((field, type) => '    $field: $type.${field == 'colours' ? mode : 'standard'},\n');

  return '''
/// The design tokens this app shares with the portal, as one theme extension, so no widget holds
/// its own colour, type size, spacing, radius or duration. Widgets read them with
/// `context.lookUpTokens`.
@immutable
class LookUpTokens extends ThemeExtension<LookUpTokens> {
  /// Tokens made of these groups.
  const LookUpTokens({
${eachGroup((field, type) => '    required this.$field,\n')}  });

  /// The light theme: the only one the app shows in Step 4.
  static const LookUpTokens light = LookUpTokens(
${tokensConstant('light')}  );

  /// The dark theme's values, generated now and shown from Phase 6 (P6-THEME-01).
  static const LookUpTokens dark = LookUpTokens(
${tokensConstant('dark')}  );
${eachGroup((field, type) => '\n  final $type $field;\n')}
  @override
  LookUpTokens copyWith({
${eachGroup((field, type) => '    $type? $field,\n')}  }) {
    return LookUpTokens(
${eachGroup((field, type) => '      $field: $field ?? this.$field,\n')}    );
  }

  /// Colours blend during a theme change; the other groups are the same in both themes, so they
  /// switch at the halfway point.
  @override
  LookUpTokens lerp(LookUpTokens? other, double t) {
    if (other == null) return this;
    return LookUpTokens(
${eachGroup((field, type) => field == 'colours' ? '      colours: LookUpColours.lerp(colours, other.colours, t),\n' : '      $field: t < 0.5 ? $field : other.$field,\n')}    );
  }
}
''';
}

String _coloursClassSource(Map<String, String> lightColours, Map<String, String> darkColours) {
  String eachColour(String Function(String name) line) => lightColours.keys.map(line).join();
  String palette(Map<String, String> colours) =>
      colours.entries.map((colour) => '    ${colour.key}: ${colour.value},\n').join();

  return '''
/// One mode's colours, named as in tokens.json. The only place the app writes a colour value
/// (S4-THEME-03).
@immutable
class LookUpColours {
  /// Colours made of these values.
  const LookUpColours({
${eachColour((name) => '    required this.$name,\n')}  });

  /// The light mode's colours.
  static const LookUpColours light = LookUpColours(
${palette(lightColours)}  );

  /// The dark mode's colours.
  static const LookUpColours dark = LookUpColours(
${palette(darkColours)}  );
${eachColour((name) => '\n  final Color $name;\n')}
  /// The colours part of the way from [from] to [to], for theme changes.
  static LookUpColours lerp(LookUpColours from, LookUpColours to, double t) {
    return LookUpColours(
${eachColour((name) => '      $name: Color.lerp(from.$name, to.$name, t)!,\n')}    );
  }
}
''';
}

String _constantGroupSource({
  required String className,
  required String documentation,
  required String fieldType,
  required Map<String, String> values,
}) {
  String eachValue(String Function(String name, String value) line) =>
      values.entries.map((entry) => line(entry.key, entry.value)).join();

  return '''
$documentation@immutable
class $className {
  /// A group made of these values.
  const $className({
${eachValue((name, value) => '    required this.$name,\n')}  });

  /// The values in tokens.json, the same in light and dark.
  static const $className standard = $className(
${eachValue((name, value) => '    $name: $value,\n')}  );
${eachValue((name, value) => '\n  final $fieldType $name;\n')}}
''';
}

Map<String, String> _readColours(Object? value, String path) {
  final colours = <String, String>{};
  _readObject(value, path).forEach((name, colour) {
    if (colour is! String || !_hexColourPattern.hasMatch(colour)) {
      throw FormatException('$path.$name must be a colour written #RRGGBB');
    }
    final digits = colour.substring(1).toUpperCase();
    // CSS writes the opacity last (#RRGGBBAA); Flutter's Color wants it first (0xAARRGGBB).
    final opacityFirstDigits = digits.length == 6
        ? 'FF$digits'
        : '${digits.substring(6)}${digits.substring(0, 6)}';
    colours[_checkFieldName(name, '$path.$name')] = 'Color(0x$opacityFirstDigits)';
  });
  return colours;
}

String _textStyleSource(Map<String, Object?> style, String path) {
  final size = _numberSource(style['size'], '$path.size');
  final lineHeight = _numberSource(style['line'], '$path.line');
  final weight = style['weight'];
  if (weight is! int || weight < 100 || weight > 900 || weight % 100 != 0) {
    throw FormatException('$path.weight must be 100, 200, … or 900');
  }
  return '''
TextStyle(
      fontSize: $size,
      height: $lineHeight / $size,
      fontWeight: FontWeight.w$weight,
      leadingDistribution: TextLeadingDistribution.even,
    )''';
}

String _aspectRatioSource(String value, String path) {
  final match = _aspectRatioPattern.firstMatch(value);
  if (match == null) {
    throw FormatException('$path must be a number or a ratio written W:H');
  }
  return '${match.group(1)} / ${match.group(2)}';
}

String _numberSource(Object? value, String path) {
  if (value is int && value >= 0) return '$value';
  if (value is double && value >= 0 && value.isFinite) return '$value';
  throw FormatException('$path must be a number of zero or more');
}

String _checkFieldName(String name, String path) {
  if (!_fieldNamePattern.hasMatch(name)) {
    throw FormatException(
      '$path: "$name" cannot be a Dart field name; '
      'rename the token or map it in tool/generate_design_tokens.dart',
    );
  }
  return name;
}

Map<String, Object?> _readObject(Object? value, String path) {
  if (value is! Map<String, Object?>) {
    throw FormatException('$path must be a JSON object');
  }
  return value;
}

/// Writes the generated file, finding tokens.json from this script's own folder, so the command
/// works from anywhere.
void main() {
  final mobileAppFolder = File.fromUri(Platform.script).parent.parent;
  final tokensFile = File.fromUri(
    mobileAppFolder.uri.resolve('../../packages/design-tokens/tokens.json'),
  );
  final generatedFile = File.fromUri(
    mobileAppFolder.uri.resolve('lib/core/theme/look_up_tokens.dart'),
  );
  if (!tokensFile.existsSync()) {
    stderr.writeln('Could not find ${tokensFile.path}.');
    exitCode = 1;
    return;
  }
  try {
    generatedFile.writeAsStringSync(generateLookUpTokensSource(tokensFile.readAsStringSync()));
  } on FormatException catch (problem) {
    stderr.writeln('tokens.json cannot be used: ${problem.message}');
    exitCode = 1;
    return;
  }
  stdout.writeln('Wrote ${generatedFile.path}');
}
