import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';

import 'identify_screen_harness.dart';

void main() {
  testWidgets('system Back calls backToHome() and never pops the page itself', (tester) async {
    final harness = IdentifyScreenHarness(state: const NoMatchState());
    await harness.pump(tester, const SystemBackToHome(child: Scaffold(body: Text('A screen'))));

    await pressSystemBack(tester);
    await pressSystemBack(tester);
    expect(harness.flow.calls, ['backToHome', 'backToHome']);
    expect(find.text('A screen'), findsOneWidget);
  });
}
