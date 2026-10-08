import 'package:lookup_listener/features/result/data/clipboard_writer.dart';

/// Records what the screen copies, so a test reads the clipboard without a platform. With
/// [accepts] false it behaves like a clipboard that refused the text.
class FakeClipboardWriter implements ClipboardWriter {
  FakeClipboardWriter({this.accepts = true});

  final bool accepts;

  /// Every text the clipboard took, in order.
  final List<String> copiedTexts = [];

  @override
  Future<bool> copyText(String text) async {
    if (accepts) copiedTexts.add(text);
    return accepts;
  }
}
