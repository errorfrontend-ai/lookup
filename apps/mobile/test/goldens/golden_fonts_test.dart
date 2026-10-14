import 'package:flutter_test/flutter_test.dart';

import 'golden_fonts.dart';

/// The golden images' fonts are in the SDK with exactly the names the loader uses (P6 design §4.6):
/// the folder is listed, so a name in the wrong case fails here on Windows too.
void main() {
  test('every font file the golden images load is in the SDK folder, with exactly that name', () {
    final namesInTheFolder = GoldenFonts.folder
        .listSync()
        .map((entry) => entry.uri.pathSegments.last)
        .toSet();
    for (final fileName in GoldenFonts.families.values.expand((fileNames) => fileNames)) {
      expect(namesInTheFolder, contains(fileName));
    }
  });
}
