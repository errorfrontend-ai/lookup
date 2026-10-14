import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'golden_fonts.dart';

/// Runs before every test in `test/goldens` (and only there): the real fonts, so the images show the
/// app's words as a phone draws them (P6 design §4.6).
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  await GoldenFonts.load();
  await testMain();
}
