import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Puts text on the phone's clipboard: the number or link a listener copies when the phone could
/// not open a button (S4-D19). An interface, so tests can read what was copied without a platform.
abstract interface class ClipboardWriter {
  /// Copies [text]. Resolves to true when the clipboard took it, so the screen confirms a copy
  /// only when one happened; never throws.
  Future<bool> copyText(String text);
}

/// Copies through Flutter's [Clipboard].
final class SystemClipboardWriter implements ClipboardWriter {
  const SystemClipboardWriter();

  @override
  Future<bool> copyText(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      return true;
    } on Exception {
      // The platform refused or has no clipboard (a `PlatformException` or a missing plugin; rare).
      // Nothing was copied, so the screen must not say it was.
      return false;
    }
  }
}

/// The clipboard the Result screen uses; tests override it with a recording fake (design §3.5).
final Provider<ClipboardWriter> clipboardWriterProvider = Provider<ClipboardWriter>(
  (ref) => const SystemClipboardWriter(),
);
