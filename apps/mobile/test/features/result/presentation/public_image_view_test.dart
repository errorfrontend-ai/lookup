import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/data/https_image_provider.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/banner_box.dart';
import 'package:lookup_listener/features/result/presentation/public_image_view.dart';

import '../support/fake_image_http_client.dart';
import '../support/result_screen_harness.dart';

PublicImage _imageOf(int widthPixels, int heightPixels) => PublicImage(
  address: 'https://images.lookup.invalid/header/abc.webp',
  widthPixels: widthPixels,
  heightPixels: heightPixels,
  sizeBytes: 48000,
);

/// The banner as the card holds it: 328 dp wide, at the top of a column.
Widget _bannerOnScreen(PublicImage image) {
  return Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: 328,
        child: Column(children: [BannerBox(image: image, width: 328)]),
      ),
    ),
  );
}

ResizeImage _decodedImage(WidgetTester tester) =>
    tester.widget<Image>(find.byType(Image)).image as ResizeImage;

void main() {
  group('decoded at the size shown, by one side (design §2.6)', () {
    const banner = Size(328, 164);

    test('an image of the box\'s shape, or taller, by the box\'s width', () {
      expect(PublicImageView.decodeSizeFor(_imageOf(720, 360), banner, 3), (
        cacheWidth: 984,
        cacheHeight: null,
      ));
      expect(PublicImageView.decodeSizeFor(_imageOf(400, 400), banner, 3), (
        cacheWidth: 984,
        cacheHeight: null,
      ));
      expect(PublicImageView.decodeSizeFor(_imageOf(96, 96), const Size.square(40), 2.75), (
        cacheWidth: 110,
        cacheHeight: null,
      ));
    });

    test('an image wider than the box by the box\'s height, so it still covers the box', () {
      expect(PublicImageView.decodeSizeFor(_imageOf(1440, 360), banner, 3), (
        cacheWidth: null,
        cacheHeight: 492,
      ));
      expect(PublicImageView.decodeSizeFor(_imageOf(200, 100), const Size.square(36), 3), (
        cacheWidth: null,
        cacheHeight: 108,
      ));
    });

    test('an image whose size the answer does not give, by the box\'s width', () {
      expect(PublicImageView.decodeSizeFor(_imageOf(0, 0), banner, 3), (
        cacheWidth: 984,
        cacheHeight: null,
      ));
    });

    testWidgets('a banner wider than 2:1 is decoded at the box\'s height, not its width', (
      tester,
    ) async {
      final client = FakeImageHttpClient(
        imageBytes: await encodeTestImage(tester, width: 8, height: 2),
      );
      await withFakeImageServer(client, () async {
        await ResultScreenHarness().pump(tester, _bannerOnScreen(_imageOf(1440, 360)));
        expect(_decodedImage(tester).height, 164 * 3);
        expect(_decodedImage(tester).width, isNull);

        await waitUntilImageShows(tester, find.byType(BannerBox));
        expect(tester.getSize(find.byType(BannerBox)), const Size(328, 164));
      });
    });

    testWidgets('a 2:1 banner is decoded at the box\'s width', (tester) async {
      await withFakeImageServer(FakeImageHttpClient(), () async {
        await ResultScreenHarness().pump(tester, _bannerOnScreen(_imageOf(720, 360)));
        expect(_decodedImage(tester).width, 328 * 3);
        expect(_decodedImage(tester).height, isNull);
      });
    });
  });

  group('https at every hop (S4-D15)', () {
    testWidgets('the image loads through HttpsImageProvider', (tester) async {
      await withFakeImageServer(FakeImageHttpClient(), () async {
        await ResultScreenHarness().pump(tester, _bannerOnScreen(_imageOf(720, 360)));
        expect(
          _decodedImage(tester).imageProvider,
          const HttpsImageProvider('https://images.lookup.invalid/header/abc.webp'),
        );
      });
    });

    testWidgets('a banner whose server redirects to plain http is never fetched over http', (
      tester,
    ) async {
      final banner = _imageOf(720, 360);
      final client = FakeImageHttpClient(
        imageBytes: await encodeTestImage(tester),
        redirects: {Uri.parse(banner.address): 'http://images.lookup.invalid/header/abc.webp'},
      );
      await withFakeImageServer(client, () async {
        await ResultScreenHarness().pump(tester, _bannerOnScreen(banner));
        for (var attempt = 0; attempt < 10; attempt++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
          await tester.pump();
        }

        expect(tester.takeException(), isNull);
        expect(client.requestedAddresses, [Uri.parse(banner.address)]);
        expect(isImageShown(tester, find.byType(BannerBox)), isFalse);
        final fill = find.descendant(of: find.byType(BannerBox), matching: find.byType(ColoredBox));
        expect(tester.widget<ColoredBox>(fill.first).color, LookUpTokens.light.colours.lineSoft);
      });
    });
  });
}
