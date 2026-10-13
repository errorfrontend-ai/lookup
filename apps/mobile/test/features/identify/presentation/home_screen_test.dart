import 'dart:convert';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/data/how_it_works_note_store.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/how_it_works_note_card.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';
import 'package:lookup_listener/features/identify/presentation/my_station_chip.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/presentation/settings_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../app/listener_app_harness.dart';
import '../../../support/phone_screen.dart';
import '../../result/support/result_screen_harness.dart'
    show expectNoClippedText, loadRobotoFamily, themeInRoboto;
import 'identify_screen_harness.dart';
import '../../../support/english_words.dart';

/// "My station" as `shared_preferences` keeps it: Station A on 98.1 FM in Lusaka.
final Map<String, Object> _stationAKept = {
  MyStationStore.myStationKey: jsonEncode({
    'id': '0192a6c4-1111-4000-8000-000000000001',
    'name': 'Station A',
    'frequency_label': '98.1 FM',
    'city': 'Lusaka',
  }),
};

/// A later launch with Station A kept, as most tests of the chip need.
Map<String, Object> get _laterLaunchWithStationA => {
  HowItWorksNoteStore.shownKey: true,
  ..._stationAKept,
};

/// A wider phone, where the test font's square letters leave room for the chip beside the title.
const PhoneScreen _widePhone = PhoneScreen(width: 411, height: 891, textScale: 1);

Finder get _chip => find.byType(MyStationChip);

Finder get _note => find.byType(HowItWorksNoteCard);

/// A development build with the developer tools on, as config/development-fake.json makes it.
AppConfiguration _developmentWithTools() => AppConfiguration(
  flavour: AppFlavour.development,
  apiBaseUrl: Uri.parse('http://10.0.2.2:3999/api/v1'),
  showsDeveloperTools: true,
);

void main() {
  group('wording (design §2.2)', () {
    testWidgets('"Look Up", the heading as a heading, the instruction and the data note', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));

      expect(find.text('Look Up'), findsOneWidget);
      expect(find.text('Heard an ad on the radio?'), findsOneWidget);
      final headingData = tester
          .getSemantics(find.text('Heard an ad on the radio?'))
          .getSemanticsData();
      expect(headingData.flagsCollection.isHeader, isTrue);
      expect(
        find.text('Tap the button and hold your phone near the radio while the ad plays.'),
        findsOneWidget,
      );
      expect(find.text('About 8 seconds of listening · about 25 KB of data'), findsOneWidget);
      semantics.dispose();
    });

    test('the "8" in the data note comes from the clip settings (S4-LISTENING-03)', () {
      final seconds = RecognitionFlow.clipSettings.clipDurationSeconds;
      expect(seconds, 8);
      expect(
        HomeScreen.dataNoteOf(englishWords),
        startsWith('About $seconds seconds of listening'),
      );
    });
  });

  group('the "My station" chip (P6 design §2.3; P6-NAVIGATION-03, -04)', () {
    testWidgets(
      'with Station A kept: "My station: Station A" with a radio icon, at the top right beside "Look Up", 48 dp tall (P6-NAVIGATION-03)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await IdentifyScreenHarness(
          preferences: _laterLaunchWithStationA,
        ).pump(tester, HomeScreen(onOpenSettings: () {}), phoneScreen: _widePhone);
        await tester.pump();

        expect(_chip, findsOneWidget);
        expect(find.descendant(of: _chip, matching: find.byIcon(Icons.radio)), findsOneWidget);
        expect(
          tester.widget<Icon>(find.descendant(of: _chip, matching: find.byIcon(Icons.radio))).size,
          16,
        );
        final label = tester.widget<Text>(find.descendant(of: _chip, matching: find.byType(Text)));
        expect(label.data, 'My station: Station A');
        final chipBox = tester.getRect(find.descendant(of: _chip, matching: find.byType(Material)));
        expect(chipBox.height, greaterThanOrEqualTo(48));
        final title = tester.getRect(find.text('Look Up'));
        expect(chipBox.left, greaterThan(title.left), reason: 'right of the title');
        expect(
          chipBox.right,
          moreOrLessEquals(411 - 20, epsilon: 0.5),
          reason: 'at the right edge',
        );
        expect(chipBox.top, lessThan(title.bottom), reason: 'on the title\'s line');
        // The whole label is read out, with where it leads.
        final data = tester.getSemantics(_chip).getSemanticsData();
        expect(data.label, 'My station: Station A');
        expect(data.hint, 'Opens Settings');
        expect(data.flagsCollection.isButton, isTrue);
        semantics.dispose();
      },
    );

    testWidgets('a white pill with a line border, from the tokens', (tester) async {
      await IdentifyScreenHarness(
        preferences: _laterLaunchWithStationA,
      ).pump(tester, HomeScreen(onOpenSettings: () {}), phoneScreen: _widePhone);
      await tester.pump();
      final material = tester.widget<Material>(
        find.descendant(of: _chip, matching: find.byType(Material)),
      );
      expect(material.color, LookUpTokens.light.colours.surface);
      final shape = material.shape! as StadiumBorder;
      expect(shape.side.color, LookUpTokens.light.colours.line);
    });

    testWidgets('with no station kept: "My station: Not set" (Q8)', (tester) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      await tester.pump();
      expect(find.text('My station: Not set'), findsOneWidget);
      expect(find.textContaining('Station A'), findsNothing);
    });

    testWidgets('a tap on the chip calls for Settings', (tester) async {
      var settingsOpened = 0;
      await IdentifyScreenHarness().pump(
        tester,
        HomeScreen(onOpenSettings: () => settingsOpened++),
      );
      await tester.pump();
      await tester.tap(_chip);
      expect(settingsOpened, 1);
    });

    testWidgets('in the app, the chip opens the Settings tab (P6-NAVIGATION-04)', (tester) async {
      final harness = ListenerAppHarness(storedPreferences: _stationAKept);
      await harness.pumpApp(tester);
      await tester.tap(_chip);
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/settings');
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(
        find.text('Station A · 98.1 FM — used when an ad is on more than one station'),
        findsOneWidget,
      );
    });

    testWidgets('a long name is cut with "…" beside the title, and read out whole', (tester) async {
      final semantics = tester.ensureSemantics();
      final longName = {
        HowItWorksNoteStore.shownKey: true,
        MyStationStore.myStationKey: jsonEncode({
          'id': '0192a6c4-1111-4000-8000-000000000001',
          'name': 'Radio Maria Zambia',
          'frequency_label': '107.1 FM',
          'city': 'Lusaka',
        }),
      };
      await IdentifyScreenHarness(
        preferences: longName,
      ).pump(tester, HomeScreen(onOpenSettings: () {}), phoneScreen: _widePhone);
      await tester.pump();
      final label = tester.widget<Text>(find.descendant(of: _chip, matching: find.byType(Text)));
      expect(label.maxLines, 1);
      expect(label.overflow, TextOverflow.ellipsis);
      expect(
        tester.getSize(_chip).width,
        lessThanOrEqualTo(411 - 40 - tester.getSize(find.text('Look Up')).width),
      );
      expect(tester.getSemantics(_chip).label, 'My station: Radio Maria Zambia');
      semantics.dispose();
    });

    testWidgets('at text scale 2.0 the chip moves under "Look Up", its words whole', (
      tester,
    ) async {
      for (final phoneScreen in [
        const PhoneScreen(width: 360, height: 800, textScale: 2),
        const PhoneScreen(width: 320, height: 640, textScale: 2),
      ]) {
        await IdentifyScreenHarness(
          preferences: _laterLaunchWithStationA,
        ).pump(tester, HomeScreen(onOpenSettings: () {}), phoneScreen: phoneScreen);
        await tester.pump();
        expect(
          tester.getTopLeft(_chip).dy,
          greaterThanOrEqualTo(tester.getBottomLeft(find.text('Look Up')).dy),
          reason: 'under the title on $phoneScreen',
        );
        expect(tester.takeException(), isNull);
        expectNoClippedText(tester);
      }
    });

    testWidgets('a station chosen with "Remember" shows on the chip at once (P6-CHOOSER-07)', (
      tester,
    ) async {
      final harness = ListenerAppHarness();
      harness.answerWithResponseFixture('valid/choose-station');
      await harness.pumpApp(tester);
      expect(find.text('My station: Not set'), findsOneWidget);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      await harness.recordWholeClip(tester);
      await tester.tap(find.text('Station B'));
      await harness.pumpTransition(tester);
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
      expect(find.text('My station: Station B'), findsOneWidget);
    });
  });

  group('the first-open note "How Look Up works" (P6 design §2.3, Q20; ALL-USABILITY-04)', () {
    const firstLaunch = <String, Object>{};

    Future<bool?> storedFlag() async =>
        (await SharedPreferences.getInstance()).getBool(HowItWorksNoteStore.shownKey);

    testWidgets(
      'on the first launch: the title, both sentences and "Got it", under the header and above the question (ALL-USABILITY-04)',
      (tester) async {
        await IdentifyScreenHarness(
          preferences: firstLaunch,
        ).pump(tester, HomeScreen(onOpenSettings: () {}));
        await tester.pump();

        expect(_note, findsOneWidget);
        expect(find.text('How Look Up works'), findsOneWidget);
        expect(
          find.text(
            'Tap Identify while an ad plays on the radio, and Look Up shows the advertiser\'s '
            'buttons: call, chat, directions or website.',
          ),
          findsOneWidget,
        );
        expect(
          find.text(
            'Ads you identify are saved in History, so their buttons work even without data.',
          ),
          findsOneWidget,
        );
        expect(find.widgetWithText(TextButton, 'Got it'), findsOneWidget);
        expect(
          tester.getTopLeft(_note).dy,
          greaterThan(tester.getBottomLeft(find.text('Look Up')).dy),
        );
        expect(
          tester.getBottomLeft(_note).dy,
          lessThan(tester.getTopLeft(find.text('Heard an ad on the radio?')).dy),
        );
        // The Step 4 instruction line stays as it is.
        expect(
          find.text('Tap the button and hold your phone near the radio while the ad plays.'),
          findsOneWidget,
        );
      },
    );

    testWidgets('it is recorded as shown as soon as it has been drawn, before any tap', (
      tester,
    ) async {
      await IdentifyScreenHarness(
        preferences: firstLaunch,
      ).pump(tester, HomeScreen(onOpenSettings: () {}));
      await tester.pump();
      expect(_note, findsOneWidget);
      await tester.pump();
      expect(await storedFlag(), isTrue);
    });

    testWidgets('a later launch shows no note, whether or not "Got it" was tapped', (tester) async {
      // The first launch, left without tapping "Got it".
      await IdentifyScreenHarness(
        preferences: firstLaunch,
      ).pump(tester, HomeScreen(onOpenSettings: () {}));
      await tester.pump();
      await tester.pump();
      expect(_note, findsOneWidget);
      final stored = (await SharedPreferences.getInstance()).getBool(HowItWorksNoteStore.shownKey)!;

      // The next launch: a new app (a new provider container) over what the phone kept.
      await tester.pumpWidget(const SizedBox());
      await IdentifyScreenHarness(
        preferences: {HowItWorksNoteStore.shownKey: stored},
      ).pump(tester, HomeScreen(onOpenSettings: () {}));
      await tester.pump();
      await tester.pump();
      expect(_note, findsNothing);
      expect(find.text('How Look Up works'), findsNothing);
    });

    testWidgets('"Got it" hides it for the rest of this launch', (tester) async {
      final harness = ListenerAppHarness(isFirstLaunch: true);
      await harness.pumpApp(tester);
      expect(_note, findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Got it'));
      await tester.pump();
      expect(_note, findsNothing);
      // Through another tab and back: still hidden.
      await tester.tap(find.text('History'));
      await harness.pumpTransition(tester);
      await tester.tap(find.text('Identify'));
      await harness.pumpTransition(tester);
      expect(find.byType(HomeScreen), findsOneWidget);
      expect(_note, findsNothing);
      expect(await storedFlag(), isTrue);
    });

    testWidgets(
      'screen readers meet it as one region named "How Look Up works", its title a heading, the icon skipped',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await IdentifyScreenHarness(
          preferences: firstLaunch,
        ).pump(tester, HomeScreen(onOpenSettings: () {}));
        await tester.pump();
        final region = tester.getSemantics(_note);
        expect(region.label, 'How Look Up works');
        expect(region.getSemanticsData().role, SemanticsRole.region);
        expect(
          tester
              .getSemantics(find.text('How Look Up works'))
              .getSemanticsData()
              .flagsCollection
              .isHeader,
          isTrue,
        );
        expect(find.descendant(of: _note, matching: find.byType(ExcludeSemantics)), findsWidgets);
        semantics.dispose();
      },
    );

    testWidgets(
      'with the note: fits at 360 and 320 dp, text scale 1.0 and 2.0, and meets the guidelines in both themes',
      (tester) async {
        await IdentifyScreenHarness(
          preferences: firstLaunch,
        ).expectFitsEveryPhone(tester, HomeScreen(onOpenSettings: () {}));
        for (final theme in [LookUpTheme.light(), LookUpTheme.dark()]) {
          final semantics = tester.ensureSemantics();
          await IdentifyScreenHarness(
            preferences: firstLaunch,
          ).pump(tester, HomeScreen(onOpenSettings: () {}), theme: theme);
          await tester.pump();
          expect(_note, findsOneWidget);
          // The identify control may sit partly below the fold in the test's square font: the
          // Flutter guidelines are checked here, and the controls' words in the system font below.
          await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
          await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
          await expectLater(tester, meetsGuideline(textContrastGuideline));
          semantics.dispose();
        }
      },
    );

    testWidgets(
      'in the system font, the note never pushes "Tap to identify" off a 320 × 640 screen at text scale 1.0, and leaves the whole disc on a 360 × 800 one',
      (tester) async {
        await loadRobotoFamily(tester);
        for (final (phoneScreen, isWholeDisc) in [
          (const PhoneScreen(width: 320, height: 640, textScale: 1), false),
          (PhoneScreen.standard, true),
        ]) {
          await tester.pumpWidget(const SizedBox());
          await IdentifyScreenHarness(preferences: firstLaunch).pump(
            tester,
            HomeScreen(onOpenSettings: () {}),
            phoneScreen: phoneScreen,
            theme: themeInRoboto(LookUpTheme.light()),
          );
          await tester.pump();
          expect(_note, findsOneWidget);
          final words = tester.getRect(find.text('Tap to identify'));
          expect(words.bottom, lessThanOrEqualTo(phoneScreen.height), reason: '$phoneScreen');
          expect(
            find.text('Tap to identify').hitTestable(),
            findsOneWidget,
            reason: '$phoneScreen',
          );
          if (isWholeDisc) {
            expect(
              tester.getBottomLeft(find.byType(IdentifyButton)).dy,
              lessThanOrEqualTo(phoneScreen.height),
            );
          }
        }
      },
    );
  });

  group('the identify control', () {
    testWidgets('one primary control, "Tap to identify", with the microphone and two rings', (
      tester,
    ) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));

      expect(find.byType(IdentifyButton), findsOneWidget);
      expect(find.text('Tap to identify'), findsOneWidget);
      expect(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byIcon(Icons.mic_none)),
        findsOneWidget,
      );
      final halo = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byType(DecoratedBox)).first,
      );
      expect((halo.decoration as BoxDecoration).boxShadow, hasLength(2));
      // 200 dp across, the wireframe's disc.
      final disc = find.descendant(of: find.byType(IdentifyButton), matching: find.byType(InkWell));
      expect(tester.getSize(disc), const Size(200, 200));
      // Nothing else on Home is a filled or outlined button.
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
    });

    testWidgets('sits below the middle of a 360 × 800 screen, in the thumb zone', (tester) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      expect(tester.getCenter(find.byType(IdentifyButton)).dy, greaterThan(800 / 2));
    });

    testWidgets('screen readers hear "Identify the ad playing now", a button with a tap', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      expect(
        tester.getSemantics(find.byType(IdentifyButton)),
        isSemantics(label: 'Identify the ad playing now', isButton: true, hasTapAction: true),
      );
      expect(find.bySemanticsLabel('Tap to identify'), findsNothing);
      semantics.dispose();
    });

    testWidgets('a tap calls identify() on the flow', (tester) async {
      final harness = IdentifyScreenHarness();
      await harness.pump(tester, HomeScreen(onOpenSettings: () {}));
      await tester.tap(find.text('Tap to identify'));
      expect(harness.flow.calls, ['identify']);
    });

    testWidgets('with the microphone allowed, a tap starts Listening (T1)', (tester) async {
      final harness = ListenerAppHarness();
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/listening');
      expect(find.text(englishWords.listeningHeading), findsOneWidget);
      expect(harness.permission.promptCount, 0);
      harness.flow(tester).backToHome();
      await harness.pumpTransition(tester);
    });

    testWidgets('without the microphone, a tap shows Permission and no system prompt (T2)', (
      tester,
    ) async {
      final harness = ListenerAppHarness(microphoneAccess: MicrophoneAccess.notAskedYet);
      await harness.pumpApp(tester);
      await tester.tap(find.text('Tap to identify'));
      await harness.pumpTransition(tester);
      expect(harness.location(tester), '/permission');
      expect(find.text(englishWords.permissionHeading), findsOneWidget);
      expect(harness.permission.promptCount, 0);
      expect(harness.recorder.startedIdempotencyKeys, isEmpty);
    });
  });

  group('"Send a test error" (S4-D26)', () {
    testWidgets('is not on Home in a production build', (tester) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      expect(find.text(englishWords.sendTestErrorButton), findsNothing);
    });

    testWidgets('is on Home in a development build with the developer tools, and throws', (
      tester,
    ) async {
      final harness = IdentifyScreenHarness(configuration: _developmentWithTools());
      await harness.pump(tester, HomeScreen(onOpenSettings: () {}));
      expect(find.text(englishWords.sendTestErrorButton), findsOneWidget);

      await tester.tap(find.text(englishWords.sendTestErrorButton));
      final thrown = tester.takeException();
      expect(thrown, isA<StateError>());
      expect((thrown as StateError).message, SendTestErrorButton.errorDescription);
      expect(harness.flow.calls, isEmpty);
    });
  });

  group('layout and accessibility (design §2.1, §4.3)', () {
    testWidgets('fits at 360 and 320 dp, text scale 1.0 and 2.0, with no technical text', (
      tester,
    ) async {
      await IdentifyScreenHarness().expectFitsEveryPhone(tester, HomeScreen(onOpenSettings: () {}));
    });

    testWidgets('fits with the developer control too', (tester) async {
      final harness = IdentifyScreenHarness(configuration: _developmentWithTools());
      await harness.expectFitsEveryPhone(tester, HomeScreen(onOpenSettings: () {}));
    });

    testWidgets('meets the tap target, label and contrast guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      await IdentifyScreenHarness(
        configuration: _developmentWithTools(),
      ).pump(tester, HomeScreen(onOpenSettings: () {}));
      await expectMeetsTapGuidelines(tester);
      semantics.dispose();
    });

    testWidgets('an accent disc 200 dp across, the 56 dp microphone and "Tap to identify" in '
        'on-accent, inside two soft rings 12 and 28 dp wide (S4-HOME-06, -07)', (tester) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      const colours = LookUpColours.light;
      final control = find.byType(IdentifyButton);

      final disc = tester.widget<Material>(
        find.descendant(of: control, matching: find.byType(Material)).first,
      );
      expect(disc.color, colours.accent);
      expect(disc.shape, isA<CircleBorder>());
      expect(
        tester.getSize(find.descendant(of: control, matching: find.byType(InkWell))),
        const Size.square(200),
      );
      final microphone = tester.widget<Icon>(
        find.descendant(of: control, matching: find.byIcon(Icons.mic_none)),
      );
      expect(microphone.size, 56);
      expect(microphone.color, colours.onAccent);
      expect(tester.widget<Text>(find.text('Tap to identify')).style!.color, colours.onAccent);

      final rings = tester.widget<DecoratedBox>(
        find.descendant(of: control, matching: find.byType(DecoratedBox)).first,
      );
      final ringDecoration = rings.decoration as BoxDecoration;
      expect(ringDecoration.shape, BoxShape.circle);
      expect(ringDecoration.boxShadow!.map((ring) => ring.spreadRadius), [28, 12]);
      expect(ringDecoration.boxShadow!.map((ring) => ring.color), [
        colours.accentSoft.withValues(alpha: 0.5),
        colours.accentSoft,
      ]);
      expect(ringDecoration.boxShadow!.map((ring) => ring.blurRadius), [0, 0]);
    });

    testWidgets('the halo colours come from the tokens', (tester) async {
      await IdentifyScreenHarness().pump(tester, HomeScreen(onOpenSettings: () {}));
      final halo = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(IdentifyButton), matching: find.byType(DecoratedBox)).first,
      );
      final shadows = (halo.decoration as BoxDecoration).boxShadow!;
      const colours = LookUpColours.light;
      expect(shadows.last.color, colours.accentSoft);
      expect(shadows.first.color, colours.accentSoft.withValues(alpha: 0.5));
    });
  });
}
