import 'dart:io';

import 'package:flutter/services.dart';

/// The real fonts the golden images are drawn with (P6 design §4.6): Roboto and the Material icons,
/// read from the Flutter SDK's own `material_fonts` folder, so nothing is downloaded and every image
/// shows real words instead of the test font's boxes. The file names are written exactly as the
/// folder has them, in lower case: Windows would forgive a wrong case, the Linux run of P8 would not.
abstract final class GoldenFonts {
  /// Each family the app draws with, and its files.
  static const Map<String, List<String>> families = {
    'Roboto': ['roboto-regular.ttf', 'roboto-medium.ttf', 'roboto-bold.ttf'],
    'MaterialIcons': ['materialicons-regular.otf'],
  };

  /// The SDK's font folder; `flutter test` sets `FLUTTER_ROOT` for the tests it runs.
  static Directory get folder {
    final flutterRoot = Platform.environment['FLUTTER_ROOT'];
    if (flutterRoot == null || flutterRoot.isEmpty) {
      throw StateError('FLUTTER_ROOT is not set: run the golden tests with `flutter test`');
    }
    return Directory('$flutterRoot/bin/cache/artifacts/material_fonts');
  }

  /// Loads every family into the test engine.
  static Future<void> load() async {
    for (final MapEntry(key: family, value: fileNames) in families.entries) {
      final loader = FontLoader(family);
      for (final fileName in fileNames) {
        final bytes = File('${folder.path}/$fileName').readAsBytesSync();
        loader.addFont(Future.value(ByteData.sublistView(Uint8List.fromList(bytes))));
      }
      await loader.load();
    }
  }
}
