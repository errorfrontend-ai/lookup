import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/banner_box.dart';
import 'package:lookup_listener/features/result/presentation/client_logo.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';
import 'package:lookup_listener/features/result/presentation/more_options_button.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/result/data/recognition_reporting_provider.dart';
import 'package:lookup_listener/features/result/domain/recognition_reporting.dart';
import 'package:lookup_listener/l10n/fallback_localizations.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/expect_no_technical_text.dart';
import '../../../support/phone_screen.dart';
import '../../../support/repository_file_locator.dart';
import '../../identify/presentation/identify_screen_harness.dart'
    show expectEveryControlShowsText, expectStateHeading;
import '../support/fake_image_http_client.dart';
import '../support/result_screen_harness.dart';

const PhoneScreen _narrowPhone = PhoneScreen(width: 320, height: 640, textScale: 1);

/// The wireframes' own card: "Call Brand A", "Chat on WhatsApp", "Get directions", "Visit website".
Map<String, Object?> get _wireframeCard {
  final actions = (fourActionCard['actions'] as List<Object?>).cast<Map<String, Object?>>();
  const labels = ['Call Brand A', 'Chat on WhatsApp', 'Get directions', 'Visit website'];
  const styles = ['PRIMARY', 'SECONDARY', 'OUTLINE', 'OUTLINE'];
  return cardOf([
    for (final (index, action) in actions.indexed)
      {...action, 'label': labels[index], 'style': styles[index]},
  ]);
}

/// The Result card: the box with the line-soft border drawn over its banner.
final Finder _card = find.byWidgetPredicate(
  (widget) => widget is Container && widget.foregroundDecoration != null,
);

/// The station's buttons, top to bottom.
List<ActionButton> _shownButtons(WidgetTester tester) =>
    tester.widgetList<ActionButton>(find.byType(ActionButton)).toList();

/// Sends the system Back gesture, as Android's back button does.
Future<void> _pressSystemBack(WidgetTester tester) async {
  final message = const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute'));
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    SystemChannels.navigation.name,
    message,
    (_) {},
  );
  await tester.pump();
}

void main() {
  group('header (S4-RESULT-01, -02)', () {
    testWidgets('"Found it" beside a Back arrow labelled "Back to home"', (tester) async {
      final semantics = tester.ensureSemantics();
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expect(find.text('Found it'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_back), findsOneWidget);
      expect(find.bySemanticsLabel('Back to home'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('"Found it" is a heading, announced as a status when the result appears', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expectStateHeading(tester, 'Found it', SemanticsRole.status);
      semantics.dispose();
    });

    testWidgets('"Report this" with a flag, at the bottom right, under the last button, on every '
        'kind of result and on a saved one (P6-RESULT-04, -05)', (tester) async {
      for (final kind in RecognitionResultKind.values) {
        for (final isSaved in [false, true]) {
          final result = resultWith(
            kind: kind,
            card: fixtureCard('action-card/valid/six-actions.json'),
          );
          await ResultScreenHarness().pump(
            tester,
            isSaved
                ? ResultScreen.saved(result: result, onBack: () {})
                : ResultScreen(result: result, onBackToHome: () {}),
          );
          final link = find.widgetWithText(TextButton, 'Report this');
          await tester.ensureVisible(link);
          await tester.pump();
          final reason = '${kind.name}${isSaved ? ', saved' : ''}';
          expect(link, findsOneWidget, reason: reason);
          expect(
            find.descendant(of: link, matching: find.byIcon(Icons.outlined_flag)),
            findsOneWidget,
            reason: reason,
          );
          final lastButton = tester.getRect(find.byType(ActionButton).last);
          final linkRect = tester.getRect(link);
          expect(linkRect.top, greaterThanOrEqualTo(lastButton.bottom), reason: reason);
          expect(linkRect.right, closeTo(lastButton.right, 1), reason: '$reason: at the right');
          await tester.pumpWidget(const SizedBox());
        }
      }
    });

    testWidgets('the Back arrow and the system Back gesture both lead Home (T35)', (tester) async {
      final harness = ResultScreenHarness();
      await harness.pumpResultScreen(tester, resultWith());

      await tester.tap(find.byType(ScreenExitButton));
      expect(harness.backToHomeCount, 1);

      await _pressSystemBack(tester);
      expect(harness.backToHomeCount, 2);
      // The flow moves Home; the screen itself never closes the app.
      expect(find.byType(ResultScreen), findsOneWidget);
    });
  });

  group('"✓ Saved to History" (P6 design §2.7; P6-HISTORY-14)', () {
    Future<void> showResult(WidgetTester tester, {required bool isSavedToHistory}) async {
      await ResultScreenHarness().pump(
        tester,
        ResultScreen(result: resultWith(), onBackToHome: () {}, isSavedToHistory: isSavedToHistory),
      );
    }

    testWidgets(
      'once History holds the result: a green tick and "Saved to History" under the last button (P6-HISTORY-14)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await showResult(tester, isSavedToHistory: true);
        final words = find.text('Saved to History');
        await tester.ensureVisible(words);
        await tester.pumpAndSettle();
        expect(words, findsOneWidget);
        expect(
          tester.getTopLeft(words).dy,
          greaterThan(tester.getBottomLeft(find.byType(ActionButton).last).dy),
        );
        final tick = tester.widget<Icon>(
          find.descendant(
            of: find.ancestor(of: words, matching: find.byType(Row)).first,
            matching: find.byIcon(Icons.check),
          ),
        );
        expect(tick.color, LookUpTokens.light.colours.success);
        expect(tick.size, 16);
        expect(
          tester.widget<Text>(words).style!.color,
          LookUpTokens.light.colours.muted,
          reason: 'the muted caption',
        );
        expect(find.bySemanticsLabel('Saved to History'), findsOneWidget);
        semantics.dispose();
      },
    );

    testWidgets('before History holds it, or when the save failed: no line at all', (tester) async {
      await showResult(tester, isSavedToHistory: false);
      expect(find.text('Saved to History'), findsNothing);
      expect(find.byIcon(Icons.check), findsNothing);
    });

    testWidgets('meets the contrast guideline in both themes', (tester) async {
      for (final theme in [LookUpTheme.light(), LookUpTheme.dark()]) {
        final semantics = tester.ensureSemantics();
        await ResultScreenHarness().pump(
          tester,
          ResultScreen(result: resultWith(), onBackToHome: () {}, isSavedToHistory: true),
          theme: theme,
        );
        await tester.ensureVisible(find.text('Saved to History'));
        await tester.pumpAndSettle();
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        semantics.dispose();
      }
    });
  });

  group('a saved result, opened from History (P6 design §2.10)', () {
    testWidgets(
      '"Saved result" as its heading, a Back arrow labelled "Back" that goes back, the buttons, and "Saved to History"',
      (tester) async {
        final semantics = tester.ensureSemantics();
        var backCount = 0;
        await ResultScreenHarness().pump(
          tester,
          ResultScreen.saved(result: resultWith(), onBack: () => backCount++),
        );
        expect(find.text('Saved result'), findsOneWidget);
        expect(find.text('Found it'), findsNothing);
        expect(
          tester
              .getSemantics(find.text('Saved result'))
              .getSemanticsData()
              .flagsCollection
              .isHeader,
          isTrue,
        );
        expect(find.bySemanticsLabel('Back'), findsOneWidget);
        expect(find.bySemanticsLabel('Back to home'), findsNothing);
        expect(find.byType(ActionButton), findsNWidgets(4));
        expect(find.text('Saved to History'), findsOneWidget);
        await tester.tap(find.byType(ScreenExitButton));
        await _pressSystemBack(tester);
        expect(backCount, 2);
        semantics.dispose();
      },
    );

    testWidgets('no haptic tick: nothing new arrived, the listener opened it', (tester) async {
      final platformCalls = recordPlatformCalls(tester);
      await ResultScreenHarness().pump(
        tester,
        ResultScreen.saved(result: resultWith(), onBack: () {}),
      );
      await tester.pump();
      expect(platformCalls.where((call) => call.method == 'HapticFeedback.vibrate'), isEmpty);
    });

    testWidgets('its buttons open their addresses as on a live result (P6-HISTORY-02)', (
      tester,
    ) async {
      final harness = ResultScreenHarness();
      await harness.pump(tester, ResultScreen.saved(result: resultWith(), onBack: () {}));
      await tester.tap(find.byType(ActionButton).first);
      await tester.pump();
      expect(harness.launcher.openedAddresses.single, startsWith('tel:+'));
    });

    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await ResultScreenHarness().pump(
          tester,
          ResultScreen.saved(result: resultWith(), onBack: () {}),
          theme: theme,
        );
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        expectEveryControlShowsText(tester);
        semantics.dispose();
      });
    }
  });

  group('the card (S4-RESULT-03 to -07)', () {
    testWidgets('"Brand A" and "via Station A · 98.1 FM" in the client row, under the logo row', (
      tester,
    ) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expect(find.text('Brand A'), findsOneWidget);
      expect(find.text('via Station A · 98.1 FM'), findsOneWidget);
      final logo = tester.getRect(find.byType(ClientLogo));
      final name = tester.getRect(find.text('Brand A'));
      final via = tester.getRect(find.text('via Station A · 98.1 FM'));
      expect(logo.size, const Size(40, 40));
      expect(name.left, logo.right + 12);
      expect(via.top, greaterThanOrEqualTo(name.bottom));
      expect(tester.getRect(find.text('Summer service offer')).top, greaterThan(logo.bottom));
    });

    testWidgets(
      'a white card: surface fill, a line-soft border over the banner, 16 dp corners, clipped (S4-RESULT-03)',
      (tester) async {
        await ResultScreenHarness().pumpResultScreen(
          tester,
          resultWith(headerImage: fixtureBanner),
        );
        const colours = LookUpColours.light;
        final card = tester.widget<Container>(_card);

        final fill = card.decoration! as BoxDecoration;
        expect(fill.color, colours.surface);
        expect(fill.borderRadius, BorderRadius.circular(16));
        final edge = card.foregroundDecoration! as BoxDecoration;
        expect(edge.border, Border.all(color: colours.lineSoft));
        expect(edge.borderRadius, BorderRadius.circular(16));
        expect(card.clipBehavior, Clip.antiAlias);
        // The card holds the banner, the client row and the title.
        for (final part in [find.byType(BannerBox), find.byType(ClientLogo)]) {
          expect(find.descendant(of: _card, matching: part), findsOneWidget);
        }
        expect(find.descendant(of: _card, matching: find.text('Summer service offer')), findsOne);
      },
    );

    for (final (phoneScreen, space, titleSize, logoSize) in [
      (PhoneScreen.standard, 16.0, 22.0, 40.0),
      (_narrowPhone, 12.0, 20.0, 36.0),
    ]) {
      testWidgets(
        'on $phoneScreen: banner, client row, title, then the buttons, with $space dp sides, card padding and gap, a $titleSize dp title and a $logoSize dp logo (S4-RESULT-15)',
        (tester) async {
          await ResultScreenHarness().pumpResultScreen(
            tester,
            resultWith(headerImage: fixtureBanner),
            phoneScreen: phoneScreen,
          );
          final card = tester.getRect(_card);
          final banner = tester.getRect(find.byType(BannerBox));
          final logo = tester.getRect(find.byType(ClientLogo));
          final clientRow = tester.getRect(
            find.ancestor(of: find.byType(ClientLogo), matching: find.byType(Row)).first,
          );
          final title = tester.getRect(find.text('Summer service offer'));
          final firstButton = tester.getRect(find.byType(ActionButton).first);

          expect(card.left, space);
          expect(card.right, phoneScreen.width - space);
          expect(banner.top, card.top);
          expect(clientRow.top, banner.bottom + space);
          expect(logo.left, card.left + space);
          expect(title.top, greaterThan(clientRow.bottom));
          expect(firstButton.top, card.bottom + space);
          expect(tester.widget<Text>(find.text('Summer service offer')).style!.fontSize, titleSize);
          expect(logo.size, Size.square(logoSize));
        },
      );
    }

    testWidgets('without a logo the circle shows the first letter of the client\'s name', (
      tester,
    ) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith(clientName: 'Atlas Bakery'));
      expect(
        find.descendant(of: find.byType(ClientLogo), matching: find.text('A')),
        findsOneWidget,
      );
    });

    testWidgets('the logo is hidden from screen readers; the name and title are read', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expect(find.bySemanticsLabel('B'), findsNothing);
      expect(find.bySemanticsLabel('Brand A'), findsOneWidget);
      expect(
        tester.getSemantics(find.text('Summer service offer')),
        isSemantics(label: 'Summer service offer', isHeader: true),
      );
      semantics.dispose();
    });

    testWidgets('the title uses cardTitle at 360 dp and cardTitleCompact below', (tester) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());
      expect(tester.widget<Text>(find.text('Summer service offer')).style!.fontSize, 22);

      await ResultScreenHarness().pumpResultScreen(tester, resultWith(), phoneScreen: _narrowPhone);
      expect(tester.widget<Text>(find.text('Summer service offer')).style!.fontSize, 20);
      expect(tester.getSize(find.byType(ClientLogo)), const Size(36, 36));
    });

    for (final (phoneScreen, cardWidth) in [(PhoneScreen.standard, 328.0), (_narrowPhone, 296.0)]) {
      testWidgets(
        'on $phoneScreen the banner box is the card\'s width, 2:1, the same size before and after the image, and nothing else is downloaded (S4-RESULT-04, -16, -18)',
        (tester) async {
          final client = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
          await withFakeImageServer(client, () async {
            await ResultScreenHarness().pumpResultScreen(
              tester,
              resultWith(headerImage: fixtureBanner, stationLogo: fixtureLogo),
              phoneScreen: phoneScreen,
            );
            final before = tester.getRect(find.byType(BannerBox));
            final titleBefore = tester.getRect(find.text('Summer service offer'));
            expect(before.width, cardWidth);
            expect(before.height, cardWidth / 2);
            expect(isImageShown(tester, find.byType(BannerBox)), isFalse);

            await waitUntilImageShows(tester, find.byType(BannerBox));

            expect(tester.getRect(find.byType(BannerBox)), before);
            expect(tester.getRect(find.text('Summer service offer')), titleBefore);
            final image = tester.widget<Image>(
              find.descendant(of: find.byType(BannerBox), matching: find.byType(Image)),
            );
            expect((image.image as ResizeImage).width, (cardWidth * 3).round());
            expect(client.requestedAddresses, [Uri.parse(fixtureBanner.address)]);
            expect(find.textContaining('Ad image'), findsNothing);
          });
        },
      );
    }

    testWidgets('no banner box at all without a banner (S4-D20)', (tester) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expect(find.byType(BannerBox), findsNothing);
      expect(find.byType(Image), findsNothing);
      expect(find.textContaining('Ad image'), findsNothing);
      // The client row starts 16 dp inside the card's top edge, which is 8 dp under the header.
      final cardTop = tester.getRect(find.byType(ScreenExitButton)).bottom + 8;
      final clientRow = find.ancestor(of: find.byType(ClientLogo), matching: find.byType(Row));
      expect(tester.getRect(clientRow.first).top, cardTop + 16);
    });
  });

  group('notes under the title', () {
    // Amendment A7: the answer does not say why a card is the advertiser's usual one, so the note
    // must be true in each case. On the wire the three are the same CLIENT_DEFAULT answer.
    for (final reason in [
      'the ad is out of its slots',
      'its campaign was paused after the clip was heard',
      'its campaign reached its tap limit',
    ]) {
      testWidgets(
        'the advertiser\'s default card has the one note that is true when $reason (A7)',
        (tester) async {
          final answer = const RecognizeResponseParser().read(
            httpStatus: 200,
            body:
                (ContractFixtures.readFile(
                      'recognition/recognize-response/valid/match-client-default.json',
                    )!
                    as Map<String, Object?>)['response'],
          );
          final result = (answer as MatchAnswer).result;
          expect(result.kind, RecognitionResultKind.clientDefault);
          await ResultScreenHarness().pumpResultScreen(tester, result);

          const note = "These are Brand A's usual contact details.";
          expect(find.text(note), findsOneWidget);
          expect(
            tester.getRect(find.text(note)).top,
            greaterThan(tester.getRect(find.text('Summer service offer')).bottom),
          );
          // Step 4's sentence is no longer true from P4, and is gone.
          expect(find.textContaining("isn't on air"), findsNothing);
          expect(find.textContaining('right now'), findsNothing);
          expect(_shownButtons(tester), hasLength(4));
        },
      );
    }

    testWidgets('the campaign\'s own card has no note', (tester) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());
      expect(find.textContaining('usual contact details'), findsNothing);
      expect(find.textContaining("isn't on air"), findsNothing);
      expect(find.textContaining('newer version'), findsNothing);
      expect(find.textContaining('no buttons'), findsNothing);
    });

    for (final fixture in [
      'action-card/reader/all-types-unknown-shows-update-hint.json',
      'action-card/reader/newer-schema-version-shows-update-hint.json',
    ]) {
      testWidgets('a card too new for this app states that, with no buttons ($fixture)', (
        tester,
      ) async {
        await ResultScreenHarness().pumpResultScreen(
          tester,
          resultWith(card: fixtureCard(fixture)),
        );
        expect(find.text('Some buttons need a newer version of Look Up.'), findsOneWidget);
        expect(find.text('This ad has no buttons right now.'), findsNothing);
        expect(find.byType(ActionButton), findsNothing);
      });
    }

    testWidgets('a card with no usable button says so, without the update hint', (tester) async {
      await ResultScreenHarness().pumpResultScreen(
        tester,
        resultWith(card: fixtureCard('action-card/reader/all-invalid-shows-no-hint.json')),
      );
      expect(find.text('This ad has no buttons right now.'), findsOneWidget);
      expect(find.text('Some buttons need a newer version of Look Up.'), findsNothing);
      expect(find.byType(ActionButton), findsNothing);
    });
  });

  group('the buttons (S4-RESULT-09 to -13)', () {
    testWidgets('the labels exactly as the station wrote them, in the card\'s order', (
      tester,
    ) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith(card: _wireframeCard));
      for (final label in ['Call Brand A', 'Chat on WhatsApp', 'Get directions', 'Visit website']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(_shownButtons(tester).map((button) => button.label), [
        'Call Brand A',
        'Chat on WhatsApp',
        'Get directions',
        'Visit website',
      ]);

      await ResultScreenHarness().pumpResultScreen(tester, resultWith());
      expect(_shownButtons(tester).map((button) => button.label), [
        'Call us',
        'WhatsApp us',
        'Find our shop',
        'See the menu',
      ]);
      expect(_shownButtons(tester).first.style, ActionStyle.primary);
    });

    for (final (phoneScreen, contentWidth, cardGap) in [
      (PhoneScreen.standard, 328.0, 16.0),
      (_narrowPhone, 296.0, 12.0),
    ]) {
      testWidgets(
        'on $phoneScreen: full width, at least 52 dp tall, 8 dp apart, $cardGap dp under the card',
        (tester) async {
          await ResultScreenHarness().pumpResultScreen(
            tester,
            resultWith(),
            phoneScreen: phoneScreen,
          );
          final buttons = find.byType(ActionButton);
          expect(buttons, findsNWidgets(4));
          final logo = tester.getRect(find.byType(ClientLogo));
          final sideSpace = (phoneScreen.width - contentWidth) / 2;
          for (var index = 0; index < 4; index++) {
            final button = tester.getRect(buttons.at(index));
            expect(button.width, contentWidth);
            expect(button.left, sideSpace);
            expect(button.height, greaterThanOrEqualTo(52));
            if (index > 0) expect(button.top - tester.getRect(buttons.at(index - 1)).bottom, 8);
          }
          // The card ends at its padding below the title; the first button is the gap below.
          final title = tester.getRect(find.text('Summer service offer'));
          final cardPadding = cardGap;
          expect(tester.getRect(buttons.first).top, title.bottom + cardPadding + cardGap);
          expect(logo.left, sideSpace + cardPadding);
        },
      );
    }

    testWidgets('icons per type at 360 dp: phone, speech bubble, map pin, globe', (tester) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());
      final icons = tester
          .widgetList<ActionButton>(find.byType(ActionButton))
          .map((button) => button.icon);
      expect(icons, [
        Icons.call_outlined,
        Icons.chat_bubble_outline,
        Icons.location_on_outlined,
        Icons.language,
      ]);
    });

    testWidgets('no icons below 360 dp, as Result320 draws', (tester) async {
      await ResultScreenHarness().pumpResultScreen(tester, resultWith(), phoneScreen: _narrowPhone);
      expect(_shownButtons(tester).map((button) => button.icon), everyElement(isNull));
      expect(
        find.descendant(of: find.byType(ActionButton), matching: find.byType(Icon)),
        findsNothing,
      );
    });

    testWidgets('a label over 32 characters shows 31 and "…", and is read whole', (tester) async {
      final semantics = tester.ensureSemantics();
      final card = fixtureCard('action-card/reader/over-long-label-still-shown.json');
      final label =
          ((card['actions'] as List<Object?>).single as Map<String, Object?>)['label'] as String;
      await ResultScreenHarness().pumpResultScreen(tester, resultWith(card: card));

      expect(find.text('${label.substring(0, 31)}…'), findsOneWidget);
      expect(find.text(label), findsNothing);
      expect(find.bySemanticsLabel(label), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('six actions: four, then "More options", which shows the other two', (
      tester,
    ) async {
      await ResultScreenHarness().pumpResultScreen(
        tester,
        resultWith(card: fixtureCard('action-card/valid/six-actions.json')),
      );
      expect(find.byType(ActionButton), findsNWidgets(4));
      expect(find.text('More options'), findsOneWidget);

      await tester.ensureVisible(find.byType(MoreOptionsButton));
      await tester.tap(find.byType(MoreOptionsButton));
      await tester.pump();

      expect(find.byType(ActionButton), findsNWidgets(6));
      expect(find.text('More options'), findsNothing);
    });
  });

  group('tapping a button (S4-LINKS)', () {
    testWidgets('each opens exactly the address the app builds, in an external app', (
      tester,
    ) async {
      final harness = ResultScreenHarness();
      final result = resultWith();
      await harness.pumpResultScreen(tester, result);

      for (final label in ['Call us', 'WhatsApp us', 'Find our shop', 'See the menu']) {
        await tester.tap(find.text(label));
        await tester.pump();
      }

      expect(harness.launcher.openedAddresses, [
        for (final action in result.card.visibleActions) buildActionUri(action),
      ]);
      expect(harness.launcher.openedAddresses.first, 'tel:+260977123456');
      expect(
        harness.launcher.openedAddresses[2],
        'https://www.google.com/maps/dir/?api=1&destination=-15.416700%2C28.283300',
      );
      expect(find.byType(LaunchFailureSheet), findsNothing);
    });

    testWidgets('a call the phone cannot open offers its number; copying gives E.164', (
      tester,
    ) async {
      final harness = ResultScreenHarness(launcherOpens: false);
      await harness.pumpResultScreen(tester, resultWith());

      await tester.tap(find.text('Call us'));
      await tester.pumpAndSettle();

      expect(find.text("Couldn't open this"), findsOneWidget);
      expect(find.text('+260 97 712 3456'), findsOneWidget);
      await tester.tap(find.text('Copy number'));
      await tester.pumpAndSettle();

      expect(harness.clipboard.copiedTexts, ['+260977123456']);
      expect(find.text('Number copied'), findsOneWidget);
      expect(find.byType(LaunchFailureSheet), findsNothing);
    });

    testWidgets('WhatsApp the phone cannot open offers its number too', (tester) async {
      final harness = ResultScreenHarness(launcherOpens: false);
      await harness.pumpResultScreen(tester, resultWith());

      await tester.tap(find.text('WhatsApp us'));
      await tester.pumpAndSettle();
      expect(find.text('+260 96 612 3456'), findsOneWidget);
      await tester.tap(find.text('Copy number'));
      await tester.pumpAndSettle();

      expect(harness.clipboard.copiedTexts, ['+260966123456']);
    });

    for (final label in ['Find our shop', 'See the menu']) {
      testWidgets('"$label" the phone cannot open offers the built link', (tester) async {
        final harness = ResultScreenHarness(launcherOpens: false);
        final result = resultWith();
        await harness.pumpResultScreen(tester, result);

        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(find.text('Copy number'), findsNothing);
        await tester.tap(find.text('Copy link'));
        await tester.pumpAndSettle();

        final action = result.card.visibleActions.firstWhere((action) => action.label == label);
        expect(harness.clipboard.copiedTexts, [buildActionUri(action)]);
        expect(find.text('Link copied'), findsOneWidget);
      });
    }

    testWidgets('a javascript: link is never shown by the reader', (tester) async {
      final harness = ResultScreenHarness();
      await harness.pumpResultScreen(
        tester,
        resultWith(card: fixtureCard('action-card/reader/javascript-link-skipped.json')),
      );
      expect(_shownButtons(tester).map((button) => button.label), ['Call us']);
    });

    testWidgets('a javascript: link that reached the screen still never reaches the launcher', (
      tester,
    ) async {
      final harness = ResultScreenHarness();
      const javaScriptCard = ReadActionCard(
        visibleActions: [
          LinkUiAction(
            id: 'link',
            label: 'See the menu',
            style: ActionStyle.outline,
            link: 'javascript:alert(1)',
          ),
        ],
        moreOptionsActions: [],
        skippedUnknownTypeCount: 0,
        skippedInvalidCount: 0,
        showsUpdateAppHint: false,
      );
      final result = resultWith();
      await harness.pumpResultScreen(
        tester,
        RecognitionResult(
          recognitionId: result.recognitionId,
          kind: result.kind,
          stationId: result.stationId,
          stationName: result.stationName,
          stationFrequencyLabel: result.stationFrequencyLabel,
          clientName: result.clientName,
          title: result.title,
          card: javaScriptCard,
        ),
      );

      await tester.tap(find.text('See the menu'));
      await tester.pumpAndSettle();

      expect(harness.launcher.openedAddresses, isEmpty);
      expect(find.byType(LaunchFailureSheet), findsNothing);
    });

    testWidgets('a call action carrying an extra "url" opens only tel:', (tester) async {
      final harness = ResultScreenHarness();
      await harness.pumpResultScreen(
        tester,
        resultWith(card: fixtureCard('action-card/invalid/unknown-field-on-action.json')),
      );

      await tester.tap(find.text('Call us'));
      await tester.pump();

      expect(harness.launcher.openedAddresses, ['tel:+260977123456']);
    });
  });

  group('haptic tick (S4-LISTENING-14)', () {
    for (final kind in RecognitionResultKind.values) {
      testWidgets('one tick when the ${kind.name} result appears, and none on later frames', (
        tester,
      ) async {
        final platformCalls = recordPlatformCalls(tester);
        await ResultScreenHarness().pumpResultScreen(
          tester,
          resultWith(kind: kind, card: fixtureCard('action-card/valid/six-actions.json')),
        );
        await tester.ensureVisible(find.byType(MoreOptionsButton));
        await tester.tap(find.byType(MoreOptionsButton));
        await tester.pump();

        final haptics = platformCalls.where((call) => call.method == 'HapticFeedback.vibrate');
        expect(haptics, hasLength(1));
        expect(haptics.single.arguments, 'HapticFeedbackType.selectionClick');
      });
    }
  });

  group('every phone size and text scale (S4-RESPONSIVE)', () {
    for (final phoneScreen in PhoneScreen.layoutChecks) {
      testWidgets('fits on $phoneScreen: no overflow, no clipped text, and it scrolls', (
        tester,
      ) async {
        final client = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
        await withFakeImageServer(client, () async {
          await ResultScreenHarness().pumpResultScreen(
            tester,
            resultWith(
              kind: RecognitionResultKind.clientDefault,
              headerImage: fixtureBanner,
              card: fixtureCard('action-card/valid/six-actions.json'),
            ),
            phoneScreen: phoneScreen,
          );
          await waitUntilImageShows(tester, find.byType(BannerBox));
          expect(tester.takeException(), isNull);

          await tester.ensureVisible(find.byType(MoreOptionsButton));
          await tester.pumpAndSettle();
          await tester.tap(find.byType(MoreOptionsButton));
          await tester.pumpAndSettle();
          final lastButton = find.byType(ActionButton).last;
          await tester.ensureVisible(lastButton);
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          expect(tester.getRect(lastButton).bottom, lessThanOrEqualTo(phoneScreen.height));
          final contentWidth = phoneScreen.width - (phoneScreen.width < 360 ? 24 : 32);
          expect(tester.getSize(lastButton).width, contentWidth);
          expectNoClippedText(tester);
          expectNoTechnicalText(tester);
        });
      });
    }

    testWidgets(
      'meets the tap target, label and contrast guidelines; every control but Back shows words (S4-USABILITY-01)',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await ResultScreenHarness().pumpResultScreen(
          tester,
          resultWith(
            kind: RecognitionResultKind.clientDefault,
            card: fixtureCard('action-card/valid/six-actions.json'),
          ),
        );
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        expectEveryControlShowsText(tester);
        semantics.dispose();
      },
    );

    testWidgets('keeps every control inside the safe area of a notched phone', (tester) async {
      PhoneScreen.standard.applyTo(tester);
      tester.view.padding = const FakeViewPadding(top: 32 * 3, bottom: 24 * 3);
      await ResultScreenHarness().pumpResultScreen(tester, resultWith());

      expect(tester.getRect(find.byType(ScreenExitButton)).top, greaterThanOrEqualTo(32));
      final lastButton = find.byType(ActionButton).last;
      await tester.ensureVisible(lastButton);
      await tester.pumpAndSettle();
      expect(tester.getRect(lastButton).bottom, lessThanOrEqualTo(800 - 24));
    });
  });

  testWidgets('shows no technical text, and nothing internal from the answer', (tester) async {
    await ResultScreenHarness().pumpResultScreen(
      tester,
      resultWith(kind: RecognitionResultKind.clientDefault),
    );
    expectNoTechnicalText(
      tester,
      alsoForbidden: [
        '0192a6c4', // ids: the station's, the actions'
        '+260977123456', // numbers are on the buttons' addresses, never on screen
        'https://',
        'tel:',
      ],
    );
  });

  test('the result feature plays no media: no audio or video player is imported', () {
    final folder = RepositoryFileLocator.mobileAppFolder('lib/features/result');
    final sources = folder
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'));
    expect(sources, isNotEmpty);
    for (final source in sources) {
      final text = source.readAsStringSync();
      for (final player in [
        'video_player',
        'audioplayers',
        'just_audio',
        'VideoPlayer',
        'AudioPlayer',
      ]) {
        expect(text, isNot(contains(player)), reason: '${source.path} mentions $player');
      }
    }
  });

  group('Report this (P6 design §2.14; Q6)', () {
    Future<_RecordingReporting> showResult(
      WidgetTester tester, {
      bool isReported = false,
      bool keepsReports = true,
    }) async {
      final reporting = _RecordingReporting(keepsReports: keepsReports);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [recognitionReportingProvider.overrideWithValue(reporting)],
          child: MaterialApp(
            theme: LookUpTheme.light(),
            localizationsDelegates: FallbackLocalizations.delegates,
            supportedLocales: FallbackLocalizations.supportedLocales,
            home: ResultScreen(
              result: resultWith(stationId: '0192a6c4-1111-4000-8000-000000000002'),
              onBackToHome: () {},
              isReported: isReported,
            ),
          ),
        ),
      );
      return reporting;
    }

    Future<void> openSheet(WidgetTester tester) async {
      final link = find.widgetWithText(TextButton, 'Report this');
      await tester.ensureVisible(link);
      await tester.pump();
      await tester.tap(link);
      await tester.pumpAndSettle();
    }

    testWidgets('the sheet: its title, words and four reasons; "Send report" waits for a reason', (
      tester,
    ) async {
      PhoneScreen.standard.applyTo(tester);
      await showResult(tester);
      await openSheet(tester);
      expect(find.text('Report this ad'), findsOneWidget);
      expect(find.text("What's wrong? Stations never see who reported it."), findsOneWidget);
      for (final reason in [
        'The buttons are wrong or misleading',
        "A number or link doesn't work",
        'It looks like a scam',
        'Something else',
      ]) {
        expect(find.text(reason), findsOneWidget);
      }
      expect(find.byType(TextField), findsNothing, reason: 'no free text');
      final send = find.widgetWithText(FilledButton, 'Send report');
      expect(tester.widget<FilledButton>(send).onPressed, isNull);
      await tester.tap(find.text('It looks like a scam'));
      await tester.pump();
      expect(tester.widget<FilledButton>(send).onPressed, isNotNull);
    });

    testWidgets('"Send report": the report with the station shown and the reason, thanks, then '
        '"Reported"', (tester) async {
      PhoneScreen.standard.applyTo(tester);
      final reporting = await showResult(tester);
      await openSheet(tester);
      await tester.tap(find.text('It looks like a scam'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send report'));
      await tester.pumpAndSettle();

      expect(reporting.reports, [
        (fixtureRecognitionId, '0192a6c4-1111-4000-8000-000000000002', 'LOOKS_LIKE_A_SCAM'),
      ]);
      expect(find.text("Thanks — we'll check this ad."), findsOneWidget);
      expect(find.text('Reported'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Report this'), findsNothing);
    });

    testWidgets('Cancel sends nothing, and the link stays', (tester) async {
      PhoneScreen.standard.applyTo(tester);
      final reporting = await showResult(tester);
      await openSheet(tester);
      await tester.tap(find.text('Something else'));
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(reporting.reports, isEmpty);
      expect(find.widgetWithText(TextButton, 'Report this'), findsOneWidget);
    });

    testWidgets('a report the phone could not keep: no thanks, and the link stays', (tester) async {
      PhoneScreen.standard.applyTo(tester);
      await showResult(tester, keepsReports: false);
      await openSheet(tester);
      await tester.tap(find.text('Something else'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send report'));
      await tester.pumpAndSettle();
      expect(find.text("Thanks — we'll check this ad."), findsNothing);
      expect(find.widgetWithText(TextButton, 'Report this'), findsOneWidget);
    });

    testWidgets('a result reported before says "Reported", with no link', (tester) async {
      await showResult(tester, isReported: true);
      expect(find.text('Reported'), findsOneWidget);
      expect(find.text('Report this'), findsNothing);
    });

    testWidgets('the sheet meets the tap target, label and contrast guidelines', (tester) async {
      PhoneScreen.standard.applyTo(tester);
      await showResult(tester);
      await openSheet(tester);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));
    });
  });
}

/// "Send report" as the app does it, recorded: (recognition, station, reason).
final class _RecordingReporting implements RecognitionReporting {
  _RecordingReporting({required this.keepsReports});

  final bool keepsReports;
  final List<(String, String, String)> reports = [];

  @override
  Future<bool> report({
    required String recognitionId,
    required String stationId,
    required RecognitionReportReason reason,
  }) async {
    if (!keepsReports) return false;
    reports.add((recognitionId, stationId, reason.wireName));
    return true;
  }
}
