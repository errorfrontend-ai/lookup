import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// Loads an image of the recognize answer (the banner or a logo) over `https` only, at every hop
/// (design §3.7, S4-D15).
///
/// Flutter's `NetworkImage` lets Dart's HTTP client follow redirects by itself, and a redirect may
/// lead from an `https` address to a plain `http` one: a download in clear text, which the app
/// never makes outside development. This provider turns the client's own redirects off and follows
/// each redirect itself, only when the next address is `https` too, and at most [maximumRedirects]
/// times. Anything else fails the image, and the box it sits in keeps its plain fill.
@immutable
final class HttpsImageProvider extends ImageProvider<HttpsImageProvider> {
  const HttpsImageProvider(this.address);

  /// The image's address, as the answer gave it.
  final String address;

  /// How many redirects one image may take: as many as Dart's own client follows by default.
  static const int maximumRedirects = 5;

  /// The answers that send the client to another address (`Location`).
  static const Set<int> redirectStatusCodes = {
    HttpStatus.movedPermanently,
    HttpStatus.found,
    HttpStatus.seeOther,
    HttpStatus.temporaryRedirect,
    HttpStatus.permanentRedirect,
  };

  /// Whether [address] may be fetched: an absolute `https` address with a host.
  static bool isHttpsAddress(Uri address) => address.scheme == 'https' && address.host.isNotEmpty;

  /// Hears the size of every picture downloaded, for "Used this month" (P6 design §3.16). Set once
  /// at start-up; pictures are drawn by widgets that know nothing of the meter.
  static void Function(int bytes)? onBytesDownloaded;

  static final HttpClient _sharedHttpClient = HttpClient()..autoUncompress = false;

  /// The app's one client; in tests, the one Flutter's own image hook gives, as for `NetworkImage`.
  static HttpClient get _httpClient {
    HttpClient? testClient;
    assert(() {
      testClient = debugNetworkImageHttpClientProvider?.call();
      return true;
    }());
    return testClient ?? _sharedHttpClient;
  }

  @override
  Future<HttpsImageProvider> obtainKey(ImageConfiguration configuration) =>
      SynchronousFuture<HttpsImageProvider>(this);

  @override
  ImageStreamCompleter loadImage(HttpsImageProvider key, ImageDecoderCallback decode) {
    return MultiFrameImageStreamCompleter(codec: _loadCodec(key, decode), scale: 1);
  }

  Future<ui.Codec> _loadCodec(HttpsImageProvider key, ImageDecoderCallback decode) async {
    try {
      final bytes = await _download(Uri.parse(key.address));
      return await decode(await ui.ImmutableBuffer.fromUint8List(bytes));
    } on Object {
      // Forget the failed image, so a later screen may try it again (as `NetworkImage` does). The
      // cache may not hold the key yet when the failure came early, so this waits a turn.
      scheduleMicrotask(() => PaintingBinding.instance.imageCache.evict(key));
      rethrow;
    }
  }

  static Future<Uint8List> _download(Uri firstAddress) async {
    final client = _httpClient;
    var address = firstAddress;
    for (var redirectCount = 0; ; redirectCount++) {
      if (!isHttpsAddress(address)) throw const _ImageNotLoaded('the address is not https');
      final request = await client.getUrl(address);
      // Every hop is checked here, never followed blindly by the client.
      request.followRedirects = false;
      final response = await request.close();
      final statusCode = response.statusCode;
      if (redirectStatusCodes.contains(statusCode)) {
        final location = response.headers.value(HttpHeaders.locationHeader);
        await response.drain<void>();
        if (location == null) throw const _ImageNotLoaded('a redirect with no Location');
        if (redirectCount >= maximumRedirects) throw const _ImageNotLoaded('too many redirects');
        address = address.resolve(location);
        continue;
      }
      if (statusCode != HttpStatus.ok) {
        await response.drain<void>();
        throw NetworkImageLoadException(statusCode: statusCode, uri: address);
      }
      final bytes = await consolidateHttpClientResponseBytes(response);
      onBytesDownloaded?.call(bytes.length);
      if (bytes.isEmpty) throw const _ImageNotLoaded('the answer was empty');
      return bytes;
    }
  }

  @override
  bool operator ==(Object other) => other is HttpsImageProvider && other.address == address;

  @override
  int get hashCode => address.hashCode;

  @override
  String toString() => '${objectRuntimeType(this, 'HttpsImageProvider')}("$address")';
}

/// Why an image was not loaded. Never shown: the image's box keeps its fill instead.
final class _ImageNotLoaded implements Exception {
  const _ImageNotLoaded(this.reason);

  final String reason;

  @override
  String toString() => 'The image was not loaded: $reason.';
}
