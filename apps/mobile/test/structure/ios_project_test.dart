import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';

/// The iOS project of design §3.16 and §3.20 (S4-PERMISSION-15), checked by reading its files: no
/// iOS build happens on this Windows machine (gap 32), so these are the only guard.
void main() {
  String read(String path) => RepositoryFileLocator.mobileAppFile(path).readAsStringSync();

  final informationProperties = read('ios/Runner/Info.plist');
  final podfile = read('ios/Podfile');

  test(
    'the microphone usage text is the design\'s wording, so the system prompt explains itself',
    () {
      final usage = RegExp(
        r'<key>NSMicrophoneUsageDescription</key>\s*<string>([^<]*)</string>',
      ).firstMatch(informationProperties);
      expect(
        usage?.group(1),
        'Look Up listens for a few seconds, only when you tap Identify, to recognise the ad on the radio.',
      );
    },
  );

  test('the app is called Look Up on the home screen', () {
    expect(
      RegExp(
        r'<key>CFBundleDisplayName</key>\s*<string>Look Up</string>',
      ).hasMatch(informationProperties),
      isTrue,
    );
  });

  test('permission_handler compiles in the microphone and no other permission', () {
    final enabled = RegExp(
      r"'(PERMISSION_[A-Z_]+)=1'",
    ).allMatches(podfile).map((match) => match.group(1));
    expect(enabled.toList(), ['PERMISSION_MICROPHONE']);
  });

  test('no background audio mode: the app never records in the background', () {
    expect(informationProperties.contains('UIBackgroundModes'), isFalse);
  });
}
