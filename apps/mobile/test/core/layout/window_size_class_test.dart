import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// The one window-size helper (design §3.19, §4.2; P6-RESPONSIVE-02): 599, 600, 839 and 840 dp.
void main() {
  test('the width decides the class at the tokens\' breakpoints', () {
    expect(WindowSizeClass.forWidth(320), WindowSizeClass.compact);
    expect(WindowSizeClass.forWidth(599), WindowSizeClass.compact);
    expect(WindowSizeClass.forWidth(599.9), WindowSizeClass.compact);
    expect(WindowSizeClass.forWidth(600), WindowSizeClass.medium);
    expect(WindowSizeClass.forWidth(839), WindowSizeClass.medium);
    expect(WindowSizeClass.forWidth(840), WindowSizeClass.expanded);
    expect(WindowSizeClass.forWidth(1280), WindowSizeClass.expanded);
  });

  test('the breakpoints come from the tokens, not from the helper', () {
    const narrower = LookUpBreakpoints(compact: 0, medium: 500, expanded: 700);
    expect(WindowSizeClass.forWidth(550, breakpoints: narrower), WindowSizeClass.medium);
    expect(WindowSizeClass.forWidth(700, breakpoints: narrower), WindowSizeClass.expanded);
  });

  for (final (size, expected) in [
    (const Size(360, 800), WindowSizeClass.compact),
    (const Size(800, 360), WindowSizeClass.medium),
    (const Size(800, 1280), WindowSizeClass.medium),
    (const Size(1280, 800), WindowSizeClass.expanded),
  ]) {
    testWidgets('a ${size.width.round()} × ${size.height.round()} dp window is ${expected.name}', (
      tester,
    ) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = size;
      addTearDown(tester.view.reset);
      late WindowSizeClass seen;
      await tester.pumpWidget(
        MaterialApp(
          theme: LookUpTheme.light(),
          home: Builder(
            builder: (context) {
              seen = WindowSizeClass.of(context);
              return const SizedBox();
            },
          ),
        ),
      );

      expect(seen, expected);
    });
  }
}
