import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fails when any text on screen looks technical (design §4.1): exception names, stack frames,
/// file paths, package names, SQL errors or an HTTP status line, plus any [alsoForbidden] text such
/// as the API's own `message`. The app shows only its own words (S4-D13), so one helper checks every
/// failure path the same way.
///
/// The design's "at " is matched as a stack-frame line ("at main (…)" or "#0 main (…)"), not as two
/// letters, because ordinary sentences contain "that " and "what ".
void expectNoTechnicalText(WidgetTester tester, {List<String> alsoForbidden = const []}) {
  final shownTexts = <String>[
    for (final widget in tester.allWidgets)
      if (widget is RichText)
        widget.text.toPlainText()
      else if (widget is EditableText)
        widget.controller.text,
  ];
  for (final text in shownTexts) {
    for (final forbidden in [..._forbiddenTexts, ...alsoForbidden]) {
      expect(text.contains(forbidden), isFalse, reason: 'The screen shows "$forbidden" in "$text"');
    }
    for (final pattern in _forbiddenPatterns) {
      expect(
        pattern.hasMatch(text),
        isFalse,
        reason: 'The screen shows text matching ${pattern.pattern} in "$text"',
      );
    }
  }
}

const List<String> _forbiddenTexts = [
  'Exception',
  'Error:',
  'SocketException',
  'DioException',
  'FormatException',
  '/data/',
  'package:',
  '.dart',
  'SQLSTATE',
  'Fatal error',
];

final List<RegExp> _forbiddenPatterns = [
  // A JavaScript or Java stack line: "at main (file.js:1:2)".
  RegExp(r'(^|\n)\s*at\s+\S'),
  // A Dart stack line: "#0      main (file:///…)".
  RegExp(r'#\d+\s+\S+\s+\('),
  // An HTTP status line: "HTTP/1.1 500 Internal Server Error".
  RegExp(r'HTTP/\d(\.\d)?\s+\d{3}'),
];
