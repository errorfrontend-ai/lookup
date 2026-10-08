import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';

import '../../../support/phone_screen.dart';
import 'identify_screen_harness.dart' show expectStateHeading;

void main() {
  for (final role in [SemanticsRole.status, SemanticsRole.alert]) {
    testWidgets('a heading, announced as a live region, inside a ${role.name} node', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await PhoneScreen.standard.pump(
        tester,
        Scaffold(body: StateHeading('No connection', role: role)),
      );
      expectStateHeading(tester, 'No connection', role);
      // Flutter's own check refuses a role and a live region on one node; none was reported.
      expect(tester.takeException(), isNull);
      semantics.dispose();
    });
  }

  testWidgets('drawn in the headline style (28/34, bold)', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const Scaffold(body: StateHeading('Too many tries', role: SemanticsRole.status)),
    );
    final text = tester.widget<Text>(find.text('Too many tries'));
    expect(text.style, LookUpTokens.light.typeStyles.headline);
  });
}
