import 'dart:async';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/data/https_image_provider.dart';

import '../support/fake_image_http_client.dart';

const String _banner = 'https://images.lookup.invalid/header/abc.webp';

/// Loads [address] through the provider as the screen would; true when an image arrived, false when
/// the load failed.
Future<bool> _load(WidgetTester tester, String address) async {
  final hasLoaded = await tester.runAsync(() {
    final outcome = Completer<bool>();
    final stream = HttpsImageProvider(address).resolve(ImageConfiguration.empty);
    final listener = ImageStreamListener(
      (image, synchronousCall) {
        image.dispose();
        if (!outcome.isCompleted) outcome.complete(true);
      },
      onError: (error, stackTrace) {
        if (!outcome.isCompleted) outcome.complete(false);
      },
    );
    stream.addListener(listener);
    return outcome.future.whenComplete(() => stream.removeListener(listener));
  });
  return hasLoaded!;
}

/// The image loader of the Result screen's banner and logos (design §3.7, S4-D15).
void main() {
  late FakeImageHttpClient client;

  Future<void> withClient(
    WidgetTester tester, {
    Map<Uri, String> redirects = const {},
    bool servesImages = true,
    required Future<void> Function() body,
  }) async {
    client = FakeImageHttpClient(
      imageBytes: servesImages ? await encodeTestImage(tester) : null,
      redirects: redirects,
    );
    await withFakeImageServer(client, body);
  }

  testWidgets('an https image loads with one request', (tester) async {
    await withClient(
      tester,
      body: () async {
        expect(await _load(tester, _banner), isTrue);
        expect(client.requestedAddresses, [Uri.parse(_banner)]);
      },
    );
  });

  testWidgets('a redirect to another https address is followed, by the app, not the client', (
    tester,
  ) async {
    const moved = 'https://cdn.lookup.invalid/header/abc.webp';
    await withClient(
      tester,
      redirects: {Uri.parse(_banner): moved},
      body: () async {
        expect(await _load(tester, _banner), isTrue);
        expect(client.requestedAddresses, [Uri.parse(_banner), Uri.parse(moved)]);
      },
    );
  });

  testWidgets('a redirect that names a path is read against the address, and stays https', (
    tester,
  ) async {
    await withClient(
      tester,
      redirects: {Uri.parse(_banner): '/header/moved.webp'},
      body: () async {
        expect(await _load(tester, _banner), isTrue);
        expect(
          client.requestedAddresses.last,
          Uri.parse('https://images.lookup.invalid/header/moved.webp'),
        );
      },
    );
  });

  testWidgets('a redirect from https to plain http fails the image: http is never asked for', (
    tester,
  ) async {
    await withClient(
      tester,
      redirects: {Uri.parse(_banner): 'http://images.lookup.invalid/header/abc.webp'},
      body: () async {
        expect(await _load(tester, _banner), isFalse);
        expect(client.requestedAddresses, [Uri.parse(_banner)]);
      },
    );
  });

  testWidgets('more than five redirects fail the image', (tester) async {
    await withClient(
      tester,
      redirects: {Uri.parse(_banner): _banner},
      body: () async {
        expect(await _load(tester, _banner), isFalse);
        expect(client.requestedAddresses, hasLength(HttpsImageProvider.maximumRedirects + 1));
      },
    );
  });

  testWidgets('an address that is not https is never asked for', (tester) async {
    await withClient(
      tester,
      body: () async {
        for (final address in [
          'http://images.lookup.invalid/header/abc.webp',
          'https:///header/abc.webp',
          'data:image/png;base64,AAAA',
        ]) {
          expect(await _load(tester, address), isFalse, reason: address);
        }
        expect(client.requestedAddresses, isEmpty);
      },
    );
  });

  testWidgets('an answer other than 200 fails the image', (tester) async {
    await withClient(
      tester,
      servesImages: false,
      body: () async {
        expect(await _load(tester, _banner), isFalse);
        expect(client.requestedAddresses, [Uri.parse(_banner)]);
      },
    );
  });

  test('two providers for one address are the same image to the cache', () {
    expect(const HttpsImageProvider(_banner), const HttpsImageProvider(_banner));
    expect(const HttpsImageProvider(_banner).hashCode, const HttpsImageProvider(_banner).hashCode);
    expect(
      const HttpsImageProvider(_banner),
      isNot(const HttpsImageProvider('https://images.lookup.invalid/logo/a.webp')),
    );
  });
}
