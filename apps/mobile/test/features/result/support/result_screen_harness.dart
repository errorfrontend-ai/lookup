import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';
import 'package:lookup_listener/features/result/data/engagement_recording_provider.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/phone_screen.dart';
import 'fake_action_launcher.dart';
import 'fake_clipboard_writer.dart';
import 'recording_engagements.dart';

/// Shows result widgets the way the app does — inside the app's theme, under a `ProviderScope`
/// whose launcher, clipboard and tap recording are fakes (design §4.1: dependencies replaced through provider
/// overrides only) — and counts the "Back to home" calls.
///
/// The `ProviderScope` sits above `MaterialApp`, as in the app, so the copy sheet (a route of its
/// own) reads the same fakes as the screen.
final class ResultScreenHarness {
  ResultScreenHarness({bool launcherOpens = true, bool clipboardAccepts = true})
    : launcher = FakeActionLauncher(opens: launcherOpens),
      clipboard = FakeClipboardWriter(accepts: clipboardAccepts);

  final FakeActionLauncher launcher;
  final FakeClipboardWriter clipboard;

  /// Each tap the screen queued (T54).
  final RecordingEngagements engagements = RecordingEngagements();

  /// How many times the screen asked to go Home.
  int backToHomeCount = 0;

  /// Shows a [ResultScreen] for [result] on [phoneScreen].
  Future<void> pumpResultScreen(
    WidgetTester tester,
    RecognitionResult result, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) {
    return pump(
      tester,
      ResultScreen(result: result, onBackToHome: () => backToHomeCount++),
      phoneScreen: phoneScreen,
      theme: theme,
    );
  }

  /// Shows [home] on [phoneScreen] with the fakes in place.
  Future<void> pump(
    WidgetTester tester,
    Widget home, {
    PhoneScreen phoneScreen = PhoneScreen.standard,
    ThemeData? theme,
  }) async {
    phoneScreen.applyTo(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          actionLauncherProvider.overrideWithValue(launcher),
          clipboardWriterProvider.overrideWithValue(clipboard),
          engagementRecordingProvider.overrideWithValue(engagements),
        ],
        child: MaterialApp(
          theme: theme ?? LookUpTheme.light(),
          localizationsDelegates: FallbackLocalizations.delegates,
          supportedLocales: FallbackLocalizations.supportedLocales,
          home: home,
        ),
      ),
    );
  }
}

/// The shared fixtures' four-action card (call, WhatsApp, map, link), as the station saved it.
Map<String, Object?> get fourActionCard =>
    fixtureCard('action-card/valid/all-four-action-types.json');

/// The `card` object of a shared card fixture, e.g. `action-card/valid/six-actions.json`.
Map<String, Object?> fixtureCard(String relativePath) {
  final fixture = ContractFixtures.readFile(relativePath) as Map<String, Object?>;
  return fixture['card'] as Map<String, Object?>;
}

/// The banner of the shared `match-with-images` answer: an https image, 720 × 360.
PublicImage get fixtureBanner {
  final card = _matchWithImagesResult['card'] as Map<String, Object?>;
  return _publicImage(card['header_image'] as Map<String, Object?>);
}

/// The station logo of the same answer, used where a test needs a client logo: the answer
/// fixtures have none for the client.
PublicImage get fixtureLogo {
  final station = _matchWithImagesResult['station'] as Map<String, Object?>;
  return _publicImage(station['logo'] as Map<String, Object?>);
}

/// The recognition id of the shared answer fixtures, a UUID version 7.
const String fixtureRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

/// A result from Station A on 98.1 FM in Lusaka for Brand A, as the wireframes draw it, with [card]
/// read by the shared reader.
RecognitionResult resultWith({
  Object? card,
  RecognitionResultKind kind = RecognitionResultKind.campaign,
  String clientName = 'Brand A',
  String title = 'Summer service offer',
  String stationId = '0192a6c4-1111-4000-8000-000000000001',
  String stationName = 'Station A',
  String stationFrequencyLabel = '98.1 FM',
  String? stationCity = 'Lusaka',
  PublicImage? headerImage,
  PublicImage? clientLogo,
  PublicImage? stationLogo,
}) {
  return RecognitionResult(
    recognitionId: fixtureRecognitionId,
    kind: kind,
    stationId: stationId,
    stationName: stationName,
    stationFrequencyLabel: stationFrequencyLabel,
    stationCity: stationCity,
    clientName: clientName,
    title: title,
    card: readActionCard(card ?? fourActionCard),
    headerImage: headerImage,
    clientLogo: clientLogo,
    stationLogo: stationLogo,
  );
}

/// A card of the given actions, each a JSON object as the station's card holds it.
Map<String, Object?> cardOf(List<Map<String, Object?>> actions) {
  return {'schema_version': 1, 'layout': 'VERTICAL_STACK', 'actions': actions};
}

/// A call action with [label], a distinct [id] and [style].
Map<String, Object?> callAction(String id, String label, {String style = 'PRIMARY'}) {
  return {
    'type': 'CALL',
    'id': id,
    'label': label,
    'style': style,
    'phone_number_e164': '+260977123456',
  };
}

/// Fails when any text on screen is cut short: laid out shorter than its lines need, or past its
/// line limit (S4-RESPONSIVE-03, "no clipped text at text scale 2.0").
void expectNoClippedText(WidgetTester tester) {
  final paragraphs = tester.renderObjectList<RenderParagraph>(find.byType(RichText));
  expect(paragraphs, isNotEmpty);
  for (final paragraph in paragraphs) {
    final text = paragraph.text.toPlainText();
    expect(paragraph.didExceedMaxLines, isFalse, reason: '"$text" ran past its line limit');
    final neededHeight = paragraph.getMinIntrinsicHeight(paragraph.size.width);
    expect(
      paragraph.size.height,
      greaterThanOrEqualTo(neededHeight - 0.01),
      reason: '"$text" is cut off: ${paragraph.size.height} of $neededHeight dp shown',
    );
  }
}

/// Records the platform calls the app makes (haptics, clipboard), until the test ends.
List<MethodCall> recordPlatformCalls(WidgetTester tester) {
  final calls = <MethodCall>[];
  final messenger = tester.binding.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    calls.add(call);
    return null;
  });
  addTearDown(() => messenger.setMockMethodCallHandler(SystemChannels.platform, null));
  return calls;
}

/// Loads Roboto Bold, the system font of Android phones, from the Flutter SDK's own copy (nothing
/// is downloaded), under the family name "Roboto". Flutter's test font draws every letter a full
/// square wide, so only a real font can show whether a label fits on one line.
Future<void> loadRobotoBold(WidgetTester tester) async {
  final flutterRoot = Platform.environment['FLUTTER_ROOT'];
  if (flutterRoot == null) throw StateError('FLUTTER_ROOT is not set: run with `flutter test`.');
  final fontFile = File('$flutterRoot/bin/cache/artifacts/material_fonts/roboto-bold.ttf');
  if (!fontFile.existsSync()) throw StateError('No Roboto Bold at ${fontFile.path}.');
  final fontBytes = ByteData.sublistView(fontFile.readAsBytesSync());
  final loader = FontLoader('Roboto')..addFont(Future.value(fontBytes));
  await tester.runAsync(loader.load);
}

/// Loads Roboto Regular, Medium and Bold, the system font of Android phones, from the Flutter SDK's
/// own copy (nothing is downloaded), as one family named "Roboto", so a layout can be measured as a
/// phone draws it rather than in Flutter's square test font.
Future<void> loadRobotoFamily(WidgetTester tester) async {
  final flutterRoot = Platform.environment['FLUTTER_ROOT'];
  if (flutterRoot == null) throw StateError('FLUTTER_ROOT is not set: run with `flutter test`.');
  // One loader per file: the test engine never finishes one loader that holds several fonts.
  for (final name in ['roboto-regular.ttf', 'roboto-medium.ttf', 'roboto-bold.ttf']) {
    final fontFile = File('$flutterRoot/bin/cache/artifacts/material_fonts/$name');
    if (!fontFile.existsSync()) throw StateError('No $name at ${fontFile.path}.');
    final loader = FontLoader('Roboto')
      ..addFont(Future.value(ByteData.sublistView(fontFile.readAsBytesSync())));
    await tester.runAsync(loader.load);
  }
}

/// [theme] with every text in Roboto, as a phone's system font draws it; load the family first
/// with [loadRobotoFamily]. The app's theme names no font family (S4-THEME-04), so the default text
/// style carries it to every text.
ThemeData themeInRoboto(ThemeData theme) =>
    theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'Roboto'));

/// The app's theme with the buttons' labels in Roboto, as a phone's system font draws them. The
/// app's theme names no font family (S4-THEME-04), which on a phone means Roboto and in a test
/// means the square test font.
ThemeData themeWithRobotoButtonLabels() {
  final theme = LookUpTheme.light();
  ButtonStyle withRoboto(ButtonStyle style) {
    final labelStyle = style.textStyle!.resolve(const <WidgetState>{})!;
    return style.copyWith(
      textStyle: WidgetStatePropertyAll(labelStyle.copyWith(fontFamily: 'Roboto')),
    );
  }

  return theme.copyWith(
    filledButtonTheme: FilledButtonThemeData(style: withRoboto(theme.filledButtonTheme.style!)),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: withRoboto(theme.outlinedButtonTheme.style!),
    ),
  );
}

Map<String, Object?> get _matchWithImagesResult {
  final fixture =
      ContractFixtures.readFile('recognition/recognize-response/valid/match-with-images.json')
          as Map<String, Object?>;
  final response = fixture['response'] as Map<String, Object?>;
  return response['result'] as Map<String, Object?>;
}

PublicImage _publicImage(Map<String, Object?> image) {
  return PublicImage(
    address: image['address'] as String,
    widthPixels: image['width_pixels'] as int,
    heightPixels: image['height_pixels'] as int,
    sizeBytes: image['size_bytes'] as int,
  );
}
