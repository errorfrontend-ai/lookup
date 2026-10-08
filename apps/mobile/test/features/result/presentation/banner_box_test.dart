import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/banner_box.dart';

import '../support/fake_image_http_client.dart';
import '../support/result_screen_harness.dart';

/// The banner as the card holds it: [width] wide, at the top of a column.
Widget _bannerOnScreen(PublicImage image, {double width = 328}) {
  return Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: width,
        child: Column(
          children: [BannerBox(image: image, width: width)],
        ),
      ),
    ),
  );
}

Color _fillOf(WidgetTester tester) {
  final fill = find.descendant(of: find.byType(BannerBox), matching: find.byType(ColoredBox));
  return tester.widget<ColoredBox>(fill.first).color;
}

void main() {
  testWidgets('a 2:1 box filled with line-soft, the same size before and after the image', (
    tester,
  ) async {
    final client = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _bannerOnScreen(fixtureBanner));

      final before = tester.getRect(find.byType(BannerBox));
      expect(before.size, const Size(328, 164));
      expect(_fillOf(tester), LookUpTokens.light.colours.lineSoft);
      expect(isImageShown(tester, find.byType(BannerBox)), isFalse);

      await waitUntilImageShows(tester, find.byType(BannerBox));

      expect(tester.getRect(find.byType(BannerBox)), before);
      final image = tester.widget<Image>(find.byType(Image));
      expect(image.fit, BoxFit.cover);
      expect((image.image as ResizeImage).width, 328 * 3);
      expect(client.requestedAddresses, [Uri.parse(fixtureBanner.address)]);
    });
  });

  testWidgets('a banner that fails to load keeps the box and its fill, showing nothing else', (
    tester,
  ) async {
    final client = FakeImageHttpClient();
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _bannerOnScreen(fixtureBanner, width: 296));
      for (var attempt = 0; attempt < 5; attempt++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }

      expect(tester.takeException(), isNull);
      expect(client.requestedAddresses, hasLength(1));
      expect(tester.getSize(find.byType(BannerBox)), const Size(296, 148));
      expect(_fillOf(tester), LookUpTokens.light.colours.lineSoft);
      expect(isImageShown(tester, find.byType(BannerBox)), isFalse);
      expect(find.byType(Text), findsNothing);
    });
  });

  testWidgets('a banner not served over https is never fetched; the box still holds its place', (
    tester,
  ) async {
    final client = FakeImageHttpClient();
    final plainBanner = PublicImage(
      address: fixtureBanner.address.replaceFirst('https:', 'http:'),
      widthPixels: 720,
      heightPixels: 360,
      sizeBytes: 48000,
    );
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _bannerOnScreen(plainBanner));
      expect(client.requestedAddresses, isEmpty);
      expect(find.byType(Image), findsNothing);
      expect(tester.getSize(find.byType(BannerBox)), const Size(328, 164));
    });
  });

  testWidgets('the banner is hidden from screen readers', (tester) async {
    final semantics = tester.ensureSemantics();
    final client = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
    await withFakeImageServer(client, () async {
      await ResultScreenHarness().pump(tester, _bannerOnScreen(fixtureBanner));
      await waitUntilImageShows(tester, find.byType(BannerBox));
      expect(tester.widget<Image>(find.byType(Image)).excludeFromSemantics, isTrue);
    });
    semantics.dispose();
  });
}
