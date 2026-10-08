import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Serves images to `Image.network` in widget tests, with no network: every address answers with
/// [imageBytes], or with 404 when they are null. It records every address asked for, so a test can
/// prove the screen downloads nothing but its images (S4-RESULT-18).
class FakeImageHttpClient extends Fake implements HttpClient {
  FakeImageHttpClient({this.imageBytes});

  /// A real encoded image (see [encodeTestImage]), or null to answer 404.
  final Uint8List? imageBytes;

  /// Every address requested, in order.
  final List<Uri> requestedAddresses = [];

  @override
  bool autoUncompress = false;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    requestedAddresses.add(url);
    return _FakeImageRequest(imageBytes);
  }
}

class _FakeImageRequest extends Fake implements HttpClientRequest {
  _FakeImageRequest(this._imageBytes);

  final Uint8List? _imageBytes;

  @override
  Future<HttpClientResponse> close() async => _FakeImageResponse(_imageBytes);
}

class _FakeImageResponse extends Fake implements HttpClientResponse {
  _FakeImageResponse(this._imageBytes);

  final Uint8List? _imageBytes;

  @override
  int get statusCode => _imageBytes == null ? HttpStatus.notFound : HttpStatus.ok;

  @override
  int get contentLength => _imageBytes?.length ?? 0;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;

  @override
  Future<FutureValueT> drain<FutureValueT>([FutureValueT? futureValue]) async =>
      futureValue as FutureValueT;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    final chunks = Stream<List<int>>.fromIterable([?_imageBytes]);
    return chunks.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }
}

/// Runs [body] with `Image.network` fetching through [client], with an empty image cache, and puts
/// the real client back before the test ends (Flutter checks that it was).
Future<void> withFakeImageServer(FakeImageHttpClient client, Future<void> Function() body) async {
  PaintingBinding.instance.imageCache
    ..clear()
    ..clearLiveImages();
  debugNetworkImageHttpClientProvider = () => client;
  try {
    await body();
  } finally {
    debugNetworkImageHttpClientProvider = null;
  }
}

/// A small PNG, encoded by the engine itself, so the decoder has a real image to decode.
Future<Uint8List> encodeTestImage(WidgetTester tester, {int width = 4, int height = 2}) async {
  final bytes = await tester.runAsync(() async {
    final recorder = ui.PictureRecorder();
    Canvas(recorder).drawRect(Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()), Paint());
    final picture = recorder.endRecording();
    final image = await picture.toImage(width, height);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      return data!.buffer.asUint8List();
    } finally {
      image.dispose();
      picture.dispose();
    }
  });
  return bytes!;
}

/// Lets the image under [within] download and decode, which takes real time in the engine, then
/// shows the frame that holds it. Fails when it never appears.
Future<void> waitUntilImageShows(WidgetTester tester, Finder within) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
    if (isImageShown(tester, within)) return;
  }
  fail('The image under $within never appeared.');
}

/// Whether an image has been painted under [within].
bool isImageShown(WidgetTester tester, Finder within) {
  final rawImages = find.descendant(of: within, matching: find.byType(RawImage));
  return tester.widgetList<RawImage>(rawImages).any((rawImage) => rawImage.image != null);
}
