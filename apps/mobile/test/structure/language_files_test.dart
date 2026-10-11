import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';
import 'package:lookup_listener/l10n/app_localizations_en.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../support/repository_file_locator.dart';
import 'support/naming_rules.dart';

/// The language files (design §3.17, §4.5; P6-LOCALISATION-01 to -03): `app_en.arb` is complete
/// and described, the generated classes hold exactly its messages with its English words, and a
/// language Flutter ships no Material texts for (Bemba, Nyanja) still gets a working screen.
///
/// The byte-for-byte check of the generated files is the gate's `flutter gen-l10n` followed by
/// `git diff --exit-code lib/l10n` (design §4.11); this test proves they agree with the ARB file.
void main() {
  final arbText = RepositoryFileLocator.mobileAppFile('lib/l10n/app_en.arb').readAsStringSync();
  final arb = jsonDecode(arbText) as Map<String, Object?>;
  final messageKeys = [
    for (final key in arb.keys)
      if (!key.startsWith('@')) key,
  ];
  final englishSource = RepositoryFileLocator.mobileAppFile(
    'lib/l10n/app_localizations_en.dart',
  ).readAsStringSync();
  final abstractSource = RepositoryFileLocator.mobileAppFile(
    'lib/l10n/app_localizations.dart',
  ).readAsStringSync();
  final english = AppLocalizationsEn();

  group('app_en.arb (P6-LOCALISATION-02)', () {
    test('is the English template and holds the app\'s words', () {
      expect(arb['@@locale'], 'en');
      expect(messageKeys.length, greaterThanOrEqualTo(80));
    });

    test('every message has a non-empty English value and a description', () {
      for (final key in messageKeys) {
        final value = arb[key];
        expect(value, isA<String>(), reason: key);
        expect((value! as String).trim(), isNotEmpty, reason: key);
        final attributes = arb['@$key'];
        expect(attributes, isA<Map<String, Object?>>(), reason: '$key has no @$key');
        final description = (attributes! as Map<String, Object?>)['description'];
        expect(description, isA<String>(), reason: '$key has no description');
        expect((description! as String).trim().length, greaterThan(10), reason: key);
      }
    });

    test('every placeholder a message uses is declared with its type', () {
      final placeholderUse = RegExp(r'\{(\w+)[,}]');
      for (final key in messageKeys) {
        final used = {
          for (final match in placeholderUse.allMatches(arb[key]! as String)) match.group(1)!,
        };
        final declared =
            ((arb['@$key']! as Map<String, Object?>)['placeholders'] as Map<String, Object?>?) ??
            const <String, Object?>{};
        expect(used, declared.keys.toSet(), reason: key);
        for (final placeholder in declared.values) {
          expect((placeholder! as Map<String, Object?>)['type'], anyOf('int', 'String'));
        }
      }
    });

    test('keys are whole words in lower camel case (docs/conventions.md)', () {
      final lowerCamelCase = RegExp(r'^[a-z][a-zA-Z0-9]*$');
      for (final key in messageKeys) {
        expect(key, matches(lowerCamelCase));
        expect(NamingRules.bannedShortWordsIn(key), isEmpty, reason: key);
      }
    });

    test('no annotation without its message', () {
      for (final key in arb.keys.where((key) => key.startsWith('@') && key != '@@locale')) {
        expect(arb.containsKey(key.substring(1)), isTrue, reason: key);
      }
    });
  });

  group('the generated classes agree with app_en.arb', () {
    test('the abstract class declares exactly the ARB messages, in order', () {
      final declared = [
        for (final match in RegExp(
          r'^  String (?:get )?(\w+)(?:\(|;)',
          multiLine: true,
        ).allMatches(abstractSource))
          match.group(1)!,
      ];
      expect(declared, messageKeys);
    });

    test('the English class has each message without a placeholder word for word', () {
      final getter = RegExp(r"String get (\w+) =>\s*'((?:[^'\\]|\\.)*)';", multiLine: true);
      final englishValues = {
        for (final match in getter.allMatches(englishSource))
          match.group(1)!: _unescapeDartText(match.group(2)!),
      };
      final simpleKeys = [
        for (final key in messageKeys)
          if (!(arb[key]! as String).contains('{')) key,
      ];
      expect(simpleKeys.length, greaterThan(70));
      for (final key in simpleKeys) {
        expect(englishValues[key], arb[key], reason: key);
      }
    });

    test('the messages with numbers and names read as the screens need them', () {
      expect(english.listeningSecondsLeft(8), '8 seconds left');
      expect(english.listeningSecondsLeft(1), '1 second left');
      expect(english.listeningSecondsLeft(0), '0 seconds left');
      expect(english.busyCountdown(12), '12 s');
      expect(english.busyCountdownSpoken(12), '12 seconds');
      expect(english.busyCountdownSpoken(1), '1 second');
      expect(english.homeDataNote(8), 'About 8 seconds of listening · about 25 KB of data');
      expect(english.resultViaStation('Station A', '98.1 FM'), 'via Station A · 98.1 FM');
      expect(
        english.resultClientDefaultNote('Brand A'),
        "This ad isn't on air right now, so these are Brand A's usual contact details.",
      );
      expect(
        english.supportChatMessage('6F1C-2D3E'),
        'Hello Look Up support, my reference code is 6F1C-2D3E.',
      );
    });

    test('the app supports exactly the languages with an ARB file', () {
      final arbLocales = [
        for (final entity in RepositoryFileLocator.mobileAppFolder('lib/l10n').listSync())
          if (RegExp(r'app_(\w+)\.arb$').firstMatch(entity.path) case final match?) match.group(1)!,
      ];
      expect(
        AppLocalizations.supportedLocales.map((locale) => locale.toLanguageTag()).toSet(),
        arbLocales.toSet(),
      );
      expect(FallbackLocalizations.supportedLocales, AppLocalizations.supportedLocales);
    });
  });

  group('a language Flutter ships no Material texts for (P6-LOCALISATION-03)', () {
    const bemba = Locale('bem');
    const nyanja = Locale('ny');

    test('Bemba and Nyanja get the fallbacks; a language Flutter knows does not', () {
      const material = FallbackMaterialLocalizationsDelegate();
      const cupertino = FallbackCupertinoLocalizationsDelegate();
      for (final locale in [bemba, nyanja]) {
        expect(
          GlobalMaterialLocalizations.delegate.isSupported(locale),
          isFalse,
          reason: '$locale',
        );
        expect(material.isSupported(locale), isTrue, reason: '$locale');
        expect(cupertino.isSupported(locale), isTrue, reason: '$locale');
      }
      for (final locale in [const Locale('en'), const Locale('zu')]) {
        expect(material.isSupported(locale), isFalse, reason: '$locale');
        expect(cupertino.isSupported(locale), isFalse, reason: '$locale');
      }
    });

    test('the fallbacks are English', () async {
      final material = await const FallbackMaterialLocalizationsDelegate().load(bemba);
      final cupertino = await const FallbackCupertinoLocalizationsDelegate().load(nyanja);
      expect(material.backButtonTooltip, 'Back');
      expect(material.okButtonLabel, 'OK');
      expect(cupertino.todayLabel, 'Today');
    });

    test('they come after the real delegates, so a known language keeps its own texts', () {
      final delegates = FallbackLocalizations.delegates;
      expect(
        delegates.indexOf(const FallbackMaterialLocalizationsDelegate()),
        greaterThan(delegates.indexOf(GlobalMaterialLocalizations.delegate)),
      );
      expect(
        delegates.indexOf(const FallbackCupertinoLocalizationsDelegate()),
        greaterThan(delegates.indexOf(GlobalCupertinoLocalizations.delegate)),
      );
      expect(delegates, contains(AppLocalizations.delegate));
    });

    /// Shows a screen with a Back button in [locale]; gives the Back button's tooltip, or null when
    /// the screen could not be built.
    Future<String?> pumpScreenIn(
      WidgetTester tester,
      Locale locale,
      List<LocalizationsDelegate<Object?>> delegates,
    ) async {
      String? backTooltip;
      await tester.pumpWidget(
        MaterialApp(
          locale: locale,
          supportedLocales: [locale],
          localizationsDelegates: delegates,
          home: Builder(
            builder: (context) {
              backTooltip = MaterialLocalizations.of(context).backButtonTooltip;
              return const Scaffold(body: BackButton());
            },
          ),
        ),
      );
      return backTooltip;
    }

    testWidgets('a Bemba screen with Material widgets builds, with English Material texts', (
      tester,
    ) async {
      final backTooltip = await pumpScreenIn(tester, bemba, const [
        FallbackMaterialLocalizationsDelegate(),
        FallbackCupertinoLocalizationsDelegate(),
        GlobalWidgetsLocalizations.delegate,
      ]);

      expect(tester.takeException(), isNull);
      expect(backTooltip, 'Back');
      expect(find.byType(BackButton), findsOneWidget);
    });

    testWidgets('without the fallbacks the same Bemba screen cannot be built', (tester) async {
      // Flutter reports the missing texts more than once (the builder, then the Back button), so
      // the reports are collected here instead of by the test's own handler.
      final reports = <FlutterErrorDetails>[];
      final testHandler = FlutterError.onError;
      FlutterError.onError = reports.add;
      String? backTooltip;
      try {
        backTooltip = await pumpScreenIn(tester, bemba, const [
          GlobalWidgetsLocalizations.delegate,
        ]);
      } finally {
        FlutterError.onError = testHandler;
      }

      final problems = [for (final report in reports) report.exceptionAsString()];
      expect(problems, contains(contains('No MaterialLocalizations found')));
      expect(problems, contains(contains('locale, bem, is not supported')));
      expect(backTooltip, isNull);
    });
  });
}

/// The text a single-quoted Dart literal stands for (the escapes gen-l10n writes).
String _unescapeDartText(String literal) => literal.replaceAllMapped(
  RegExp(r'\\(.)'),
  (match) => switch (match.group(1)!) {
    'n' => '\n',
    't' => '\t',
    final other => other,
  },
);
