import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';

import 'identify_screen_harness.dart';

/// A screen with a Close × and, under it, [controls].
Future<void> _pumpControls(WidgetTester tester, List<Widget> controls) {
  return tester.pumpWidget(
    MaterialApp(
      theme: LookUpTheme.light(),
      home: Scaffold(
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ScreenExitButton.close(label: 'Close', onPressed: () {}),
              for (final control in controls) ...[const SizedBox(height: 16), control],
            ],
          ),
        ),
      ),
    ),
  );
}

/// The screen tests' own checks, proven able to fail (design §4.3).
void main() {
  group('expectEveryControlShowsText (S4-USABILITY-01)', () {
    testWidgets('passes when every control but Back and Close shows words', (tester) async {
      final semantics = tester.ensureSemantics();
      await _pumpControls(tester, [
        FilledButton(onPressed: () {}, child: const Text('Try again')),
        TextButton.icon(
          onPressed: () {},
          icon: const Icon(Icons.chat_bubble_outline),
          label: const Text('Message support on WhatsApp'),
        ),
      ]);

      expectEveryControlShowsText(tester);
      semantics.dispose();
    });

    testWidgets('fails on an icon-only control, even one with a screen-reader label', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _pumpControls(tester, [
        IconButton(
          onPressed: () {},
          icon: const Icon(Icons.share, semanticLabel: 'Share'),
        ),
      ]);

      expect(() => expectEveryControlShowsText(tester), throwsA(isA<TestFailure>()));
      semantics.dispose();
    });
  });
}
