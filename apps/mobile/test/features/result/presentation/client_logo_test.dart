import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/client_logo.dart';

import '../../../support/phone_screen.dart';
import '../support/fake_image_http_client.dart';
import '../support/result_screen_harness.dart';

Widget _logoOnScreen({String clientName = 'Brand A', double diameter = 40, PublicImage? logo}) {
  return Scaffold(
    body: Center(
      child: ClientLogo(clientName: clientName, diameter: diameter, logo: logo),
    ),
  );
}

void main() {
  test('the initial is the first letter of the name, upper case', () {
    expect(ClientLogo.initialOf('Brand A'), 'B');
    expect(ClientLogo.initialOf('brand A'), 'B');
    expect(ClientLogo.initialOf('  zambezi traders'), 'Z');
    expect(ClientLogo.initialOf('école'), 'É');
    expect(ClientLogo.initialOf(''), '');
    expect(ClientLogo.initialOf('   '), '');
  });

  test('a name starting with an emoji shows the whole emoji, never half of it', () {
    final shop = String.fromCharCode(0x1F6CD);
    expect(ClientLogo.initialOf('$shop Shop'), shop);
  });

  testWidgets('without a logo: the letter in the surface colour on an ink circle, 40 dp', (
    tester,
  ) async {
    final colours = LookUpTokens.light.colours;
    await ResultScreenHarness().pump(tester, _logoOnScreen(clientName: 'Atlas Bakery'));

    expect(find.text('A'), findsOneWidget);
    expect(tester.getSize(find.byType(ClientLogo)), const Size(40, 40));
    expect(tester.widget<Text>(find.text('A')).style!.color, colours.surface);
    final circle = find.descendant(of: find.byType(ClientLogo), matching: find.byType(ColoredBox));
    expect(tester.widget<ColoredBox>(circle.first).color, colours.ink);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('hidden from screen readers: the name beside it is read instead', (tester) async {
    final semantics = tester.ensureSemantics();
    await ResultScreenHarness().pump(tester, _logoOnScreen());
    expect(find.bySemanticsLabel('B'), findsNothing);
    semantics.dispose();
  });

  testWidgets('36 dp on a narrow phone; at text scale 2.0 the letter shrinks to fit', (
    tester,
  ) async {
    await ResultScreenHarness().pump(
      tester,
      _logoOnScreen(diameter: 36),
      phoneScreen: const PhoneScreen(width: 320, height: 640, textScale: 2),
    );
    expect(tester.takeException(), isNull);
    expect(tester.getSize(find.byType(ClientLogo)), const Size(36, 36));
    final letter = tester.getRect(find.text('B'));
    final circle = tester.getRect(find.byType(ClientLogo));
    expect(
      circle.contains(letter.topLeft) &&
          circle.contains(letter.bottomRight - const Offset(0.01, 0.01)),
      isTrue,
    );
    expectNoClippedText(tester);
  });

  testWidgets('with a logo: only the logo is fetched, decoded at 40 dp × the pixel ratio', (
    tester,
  ) async {
    final client = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _logoOnScreen(logo: fixtureLogo));
      await waitUntilImageShows(tester, find.byType(ClientLogo));

      expect(client.requestedAddresses, [Uri.parse(fixtureLogo.address)]);
      final image = tester.widget<Image>(
        find.descendant(of: find.byType(ClientLogo), matching: find.byType(Image)),
      );
      expect((image.image as ResizeImage).width, 40 * 3);
      expect(tester.getSize(find.byType(ClientLogo)), const Size(40, 40));
    });
  });

  testWidgets('a logo that fails to load leaves the letter, and nothing is shown or thrown', (
    tester,
  ) async {
    final client = FakeImageHttpClient();
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _logoOnScreen(logo: fixtureLogo));
      for (var attempt = 0; attempt < 5; attempt++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      expect(tester.takeException(), isNull);
      expect(client.requestedAddresses, hasLength(1));
      expect(find.text('B'), findsOneWidget);
      expect(isImageShown(tester, find.byType(ClientLogo)), isFalse);
    });
  });

  testWidgets('a logo not served over https is never fetched', (tester) async {
    final client = FakeImageHttpClient();
    final plainLogo = PublicImage(
      address: fixtureLogo.address.replaceFirst('https:', 'http:'),
      widthPixels: 96,
      heightPixels: 96,
      sizeBytes: 4200,
    );
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _logoOnScreen(logo: plainLogo));
      await tester.pump();
      expect(client.requestedAddresses, isEmpty);
      expect(find.byType(Image), findsNothing);
      expect(find.text('B'), findsOneWidget);
    });
  });
}
