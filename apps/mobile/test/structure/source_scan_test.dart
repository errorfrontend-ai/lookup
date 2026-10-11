import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/dart_source_tree.dart';
import 'support/source_rules.dart';
import 'support/temporary_folder_copy.dart';

/// The source scans of design §4.5 over `lib/` and `test/`, each proven able to fail on a planted
/// violation in a temporary copy of `lib/`.
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');
  final libraryTree = DartSourceTree.read(libraryFolder);
  final testTree = DartSourceTree.read(RepositoryFileLocator.mobileAppFolder('test'));

  test('the scans read the app and its tests', () {
    expect(libraryTree.files.length, greaterThanOrEqualTo(40));
    expect(testTree.files.length, greaterThanOrEqualTo(30));
    expect(libraryTree.files.expand((file) => file.stringLiterals), isNotEmpty);
  });

  group('lib/ breaks no source rule:', () {
    for (final rule in SourceRules.library) {
      test(rule.name, () {
        final result = rule.findViolationsIn(libraryTree);

        expect(
          result.fileCount,
          rule.onlyPathsMatching == null ? greaterThanOrEqualTo(40) : greaterThan(0),
        );
        expect(result.violations, isEmpty, reason: rule.reason);
      });
    }
  });

  group('test/ breaks no source rule:', () {
    for (final rule in SourceRules.tests) {
      test(rule.name, () {
        final result = rule.findViolationsIn(testTree);

        expect(result.fileCount, greaterThanOrEqualTo(30));
        expect(result.violations, isEmpty, reason: rule.reason);
      });
    }
  });

  test('the two button prefixes are the only web addresses allowed, and they exist', () {
    final builder = libraryTree.fileAt('features/result/domain/action_uri_builder.dart');

    expect(builder, isNotNull);
    expect(
      builder!.stringLiterals.map((literal) => literal.value),
      containsAll(SourceRules.allowedAddressLiterals[builder.path]!),
    );
  });

  group('each rule finds its planted violation in a copy of lib/:', () {
    late TemporaryFolderCopy copy;
    late DartSourceTree plantedTree;

    setUpAll(() {
      copy = TemporaryFolderCopy.of(libraryFolder);
      for (final planted in _plantedViolations) {
        copy.writeFile(planted.path, planted.contents);
      }
      plantedTree = DartSourceTree.read(copy.folder);
    });
    tearDownAll(() => copy.delete());

    for (final planted in _plantedViolations) {
      test('${planted.ruleName} in ${planted.path.split('/').last}', () {
        final rule = SourceRules.library.singleWhere((rule) => rule.name == planted.ruleName);

        expect(
          rule.findViolationsIn(plantedTree).violations,
          contains(startsWith('${planted.path} ')),
          reason: planted.contents,
        );
      });
    }

    test('every library rule has a planted violation', () {
      expect(
        SourceRules.library.map((rule) => rule.name).toSet(),
        _plantedViolations.map((planted) => planted.ruleName).toSet(),
      );
    });

    test('the motion tokens, Duration.zero and values set from them pass the duration rule', () {
      copy.writeFile('features/identify/presentation/planted_allowed_motion.dart', '''
Widget plantedRing(BuildContext context, Widget child, bool isStill) {
  final ringDuration = isStill ? Duration.zero : context.lookUpTokens.motion.fast;
  return AnimatedScale(scale: 1, duration: ringDuration, child: child);
}

AnimationController plantedBreathing(TickerProvider vsync, LookUpTokens tokens) =>
    AnimationController(vsync: vsync, duration: tokens.motion.slow, reverseDuration: Duration.zero);
''');
      final rule = SourceRules.library.singleWhere(
        (rule) => rule.name == 'animation duration not from the motion tokens',
      );
      expect(
        rule
            .findViolationsIn(DartSourceTree.read(copy.folder))
            .violations
            .where((violation) => violation.contains('planted_allowed_motion')),
        isEmpty,
      );
    });

    test(
      'a sheet or snackbar styled from the motion tokens, or not animated, passes the duration rule',
      () {
        copy.writeFile('features/result/presentation/planted_allowed_styles.dart', '''
Future<void> plantedSheet(BuildContext context, bool isStill) {
  final motion = context.lookUpTokens.motion;
  return showModalBottomSheet<void>(
    context: context,
    sheetAnimationStyle: isStill
        ? AnimationStyle.noAnimation
        : AnimationStyle(duration: motion.slow, reverseDuration: motion.base),
    builder: (context) => const SizedBox(),
  );
}

void plantedConfirm(ScaffoldMessengerState messenger, LookUpTokens tokens, bool isStill) {
  final confirmationStyle = isStill
      ? AnimationStyle.noAnimation
      : AnimationStyle(duration: tokens.motion.base, reverseDuration: tokens.motion.base);
  messenger.showSnackBar(const SnackBar(content: Text('Saved')),
      snackBarAnimationStyle: confirmationStyle);
  messenger.showSnackBar(const SnackBar(content: Text('Saved')),
      snackBarAnimationStyle: AnimationStyle.noAnimation);
}
''');
        final rule = SourceRules.library.singleWhere(
          (rule) => rule.name == 'animation duration not from the motion tokens',
        );
        expect(
          rule
              .findViolationsIn(DartSourceTree.read(copy.folder))
              .violations
              .where((violation) => violation.contains('planted_allowed_styles')),
          isEmpty,
        );
      },
    );

    test('the campaign rule knows the labels of the shared card fixtures', () {
      for (final label in ['Call us', 'WhatsApp us', 'Find our shop', 'Chat on WhatsApp']) {
        expect(SourceRules.campaignLiteralPattern.hasMatch(label), isTrue, reason: label);
      }
      for (final appText in ['Try again', 'Copy number', 'Back to home', '6F1C-2D3E', '0.1.0+1']) {
        expect(SourceRules.campaignLiteralPattern.hasMatch(appText), isFalse, reason: appText);
      }
    });

    test(
      'words from the ARB files, pure interpolations and the language files pass the words rule',
      () {
        copy
          ..writeFile('features/identify/presentation/planted_allowed_words.dart', r'''
Widget plantedHeading(AppLocalizations words, int number, Object failure) => Column(
  children: [
    Text(words.homeHeading),
    Text('$number'),
    Text('${failure.runtimeType}\n$failure'),
    ScreenExitButton.close(label: words.closeButton, onPressed: () {}),
    const Text('…'),
  ],
);
''')
          ..writeFile('l10n/planted_language_file.dart', '''
String get plantedWords => 'Heard an ad on the radio?';
Widget plantedText() => const Text('Look Up');
''');
        final rule = SourceRules.library.singleWhere(
          (rule) => rule.name == 'words written outside the ARB files',
        );
        final violations = rule.findViolationsIn(DartSourceTree.read(copy.folder)).violations;

        expect(
          violations.where((violation) => violation.contains('planted_allowed_words')),
          isEmpty,
        );
        expect(
          violations.where((violation) => violation.contains('planted_language_file')),
          isEmpty,
        );
      },
    );

    test('a rule ignores comments, and code ignores what strings say', () {
      copy.writeFile('core/planted_comment.dart', '''
// print('in a comment'); Colors.red; canLaunchUrl(address); http://api.lookup.invalid
/* debugPrint('in a block comment') */
const String plantedText = 'print(this) and Colors.red are only text here';
''');
      final tree = DartSourceTree.read(copy.folder);
      final findings = [
        for (final rule in SourceRules.library)
          ...rule
              .findViolationsIn(tree)
              .violations
              .where((violation) => violation.startsWith('core/planted_comment.dart ')),
      ];

      expect(findings, isEmpty);
    });
  });
}

final class _PlantedViolation {
  const _PlantedViolation(this.ruleName, this.path, this.contents);

  final String ruleName;
  final String path;
  final String contents;
}

final List<_PlantedViolation> _plantedViolations = [
  const _PlantedViolation(
    'API address literal',
    'core/network/planted_address.dart',
    "const String plantedBaseAddress = 'https://api.lookup.zm/api/v1';\n",
  ),
  const _PlantedViolation(
    'API address literal',
    'core/network/planted_emulator_address.dart',
    "const String plantedHost = '10.0.2.2';\n",
  ),
  const _PlantedViolation(
    'print',
    'core/planted_print.dart',
    'void plantedLog(String text) => print(text);\n',
  ),
  const _PlantedViolation(
    'debugPrint outside development_log.dart',
    'core/planted_debug_print.dart',
    "import 'package:flutter/foundation.dart';\n\n"
        'void plantedLog(String text) => debugPrint(text);\n',
  ),
  const _PlantedViolation(
    'colour outside look_up_tokens.dart',
    'core/widgets/planted_colour.dart',
    "import 'package:flutter/material.dart';\n\n"
        'const Color plantedColour = Color(0xFFB4652A);\n',
  ),
  const _PlantedViolation(
    'colour outside look_up_tokens.dart',
    'core/widgets/planted_material_colour.dart',
    "import 'package:flutter/material.dart';\n\n"
        'const Color plantedColour = Colors.red;\n',
  ),
  const _PlantedViolation(
    'canLaunchUrl',
    'features/result/data/planted_can_launch.dart',
    'Future<bool> plantedCheck(Uri address) => canLaunchUrl(address);\n',
  ),
  const _PlantedViolation(
    'hasPermission',
    'features/identify/data/planted_has_permission.dart',
    'Future<bool> plantedAsk(dynamic recorder) => recorder.hasPermission();\n',
  ),
  const _PlantedViolation(
    'recorder started outside the recognition flow',
    'app/planted_start.dart',
    'Future<void> plantedStart(dynamic recorder) =>\n'
        "    recorder.start(idempotencyKey: 'key', settings: null);\n",
  ),
  const _PlantedViolation(
    'recorder started outside the recognition flow',
    'core/planted_recorder.dart',
    'final plantedRecorder = AudioRecorder();\n',
  ),
  const _PlantedViolation(
    'recorder read by a screen',
    'features/identify/presentation/planted_screen.dart',
    'void plantedSweep(dynamic ref) => ref.read(clipRecorderProvider).deleteLeftoverClips();\n',
  ),
  const _PlantedViolation(
    'setPreferredOrientations',
    'app/planted_orientation.dart',
    'void plantedLock() => SystemChrome.setPreferredOrientations(const []);\n',
  ),
  const _PlantedViolation(
    'blur',
    'core/widgets/planted_blur.dart',
    'final plantedFilter = ImageFilter.blur(sigmaX: 4, sigmaY: 4);\n',
  ),
  const _PlantedViolation(
    'device identifier',
    'core/planted_device_identifier.dart',
    'Future<String?> plantedRead(dynamic plugin) async => plugin.androidId;\n',
  ),
  const _PlantedViolation(
    'device identifier or media player package',
    'core/planted_player_import.dart',
    "import 'package:just_audio/just_audio.dart';\n",
  ),
  const _PlantedViolation(
    'media player',
    'features/result/presentation/planted_player.dart',
    'final plantedPlayer = AudioPlayer();\n',
  ),
  const _PlantedViolation(
    'fingerprinting code',
    'features/identify/data/planted_fingerprint.dart',
    'List<int> computeFingerprint(List<int> samples) => samples;\n',
  ),
  _PlantedViolation(
    'key-like secret',
    'core/planted_secret.dart',
    // Built from parts so this test file never holds a key-shaped string itself.
    "const String plantedKey = '${'AKIA'}${'Q' * 16}';\n",
  ),
  const _PlantedViolation(
    'image without a decode size',
    'features/result/presentation/planted_image.dart',
    'Widget plantedBanner(String address) => Image.network(address, width: 320);\n',
  ),
  const _PlantedViolation(
    'image that may follow a redirect to http',
    'features/result/presentation/planted_network_image.dart',
    'Widget plantedLogo(String address) => Image.network(address, cacheWidth: 120);\n',
  ),
  const _PlantedViolation(
    'animation duration not from the motion tokens',
    'features/identify/presentation/planted_animation_duration.dart',
    'Widget plantedPulse(Widget child) =>\n'
        '    AnimatedScale(scale: 1.1, duration: const Duration(milliseconds: 250), child: child);\n',
  ),
  const _PlantedViolation(
    'animation duration not from the motion tokens',
    'core/widgets/planted_named_duration.dart',
    'const Duration plantedWait = Duration(milliseconds: 400);\n\n'
        'Widget plantedFade(Widget child) =>\n'
        '    AnimatedOpacity(opacity: 1, duration: plantedWait, child: child);\n',
  ),
  const _PlantedViolation(
    'animation duration not from the motion tokens',
    'features/result/presentation/planted_snack_bar.dart',
    'void plantedConfirm(BuildContext context) =>\n'
        "    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved')));\n",
  ),
  const _PlantedViolation(
    'animation duration not from the motion tokens',
    'core/widgets/planted_sheet.dart',
    'Future<void> plantedSheet(BuildContext context, bool isStill) => showModalBottomSheet<void>(\n'
        '  context: context,\n'
        '  sheetAnimationStyle: isStill ? AnimationStyle.noAnimation : null,\n'
        '  builder: (context) => const SizedBox(),\n'
        ');\n',
  ),
  const _PlantedViolation(
    'animation other than scale or opacity',
    'features/result/presentation/planted_slide.dart',
    'Widget plantedSlide(Animation<Offset> position, Widget child) =>\n'
        '    SlideTransition(position: position, child: child);\n',
  ),
  const _PlantedViolation(
    'animation other than scale or opacity',
    'app/planted_container.dart',
    'Widget plantedGrow(double height, Duration duration) =>\n'
        '    AnimatedContainer(height: height, duration: duration);\n',
  ),
  const _PlantedViolation(
    'campaign label or phone number',
    'features/result/presentation/planted_campaign_label.dart',
    "const String plantedLabel = 'Call us';\n",
  ),
  const _PlantedViolation(
    'campaign label or phone number',
    'features/result/domain/planted_phone_number.dart',
    "const String plantedNumber = '+260977123456';\n",
  ),
  const _PlantedViolation(
    'campaign label or phone number',
    'features/identify/presentation/planted_spaced_number.dart',
    "const String plantedNumber = '0977 123 456';\n",
  ),
  const _PlantedViolation(
    'campaign label or phone number',
    'features/identify/presentation/planted_whatsapp_label.dart',
    "const String plantedLabel = 'Message us on WhatsApp';\n",
  ),
  const _PlantedViolation(
    'banned domain word',
    'features/result/domain/planted_domain_word.dart',
    'final String plantedTenant = "station";\n',
  ),
  const _PlantedViolation(
    'abbreviated name',
    'core/planted_abbreviation.dart',
    'void plantedHandler(Object err) {}\n',
  ),
  const _PlantedViolation(
    'one-letter catch',
    'core/planted_catch.dart',
    'void plantedTry() {\n  try {\n    plantedTry();\n  } catch (e) {\n    return;\n  }\n}\n',
  ),
  const _PlantedViolation(
    'words written outside the ARB files',
    'features/identify/presentation/planted_text.dart',
    "Widget plantedHeading() => const Text('Heard an ad on the radio?');\n",
  ),
  const _PlantedViolation(
    'words written outside the ARB files',
    'features/result/presentation/planted_interpolated_text.dart',
    "Widget plantedVia(String name) => Text('via \$name');\n",
  ),
  const _PlantedViolation(
    'words written outside the ARB files',
    'core/widgets/planted_exit_label.dart',
    'Widget plantedClose(VoidCallback onPressed) =>\n'
        "    ScreenExitButton.close(label: 'Close', onPressed: onPressed);\n",
  ),
  const _PlantedViolation(
    'words written outside the ARB files',
    'features/identify/presentation/planted_spoken_label.dart',
    'Widget plantedCountdown(int seconds) =>\n'
        "    Text(words.busyCountdown(seconds), semanticsLabel: '\$seconds seconds');\n",
  ),
  const _PlantedViolation(
    'words written outside the ARB files',
    'app/planted_tooltip.dart',
    "Widget plantedBack() => IconButton(onPressed: null, tooltip: r'Back', icon: icon);\n",
  ),
  const _PlantedViolation(
    'MediaQuery.of(context).size',
    'features/result/presentation/planted_media_query.dart',
    'double plantedWidth(BuildContext context) => MediaQuery.of(context).size.width;\n',
  ),
  const _PlantedViolation(
    "a theme mode other than the phone's",
    'app/planted_theme_mode.dart',
    'Widget plantedApp() => MaterialApp(themeMode: ThemeMode.light);\n',
  ),
  const _PlantedViolation(
    "a theme mode other than the phone's",
    'core/widgets/planted_dark_theme_mode.dart',
    'const ThemeMode plantedMode = ThemeMode.dark;\n',
  ),
];
