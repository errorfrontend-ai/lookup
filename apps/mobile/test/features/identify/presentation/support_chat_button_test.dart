import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/presentation/support_chat_button.dart';

import 'identify_screen_harness.dart';

const String _expectedAddress =
    'https://wa.me/260971234567?text=Hello%20Look%20Up%20support%2C%20my%20reference%20code%20is'
    '%206F1C-2D3E.';

Widget _button({String number = '+260971234567'}) => Scaffold(
  body: SupportChatButton(supportWhatsAppNumber: number, referenceCode: '6F1C-2D3E'),
);

void main() {
  testWidgets('"Message support on WhatsApp" opens the chat with the code typed in', (
    tester,
  ) async {
    final harness = IdentifyScreenHarness();
    await harness.pump(tester, _button());
    expect(find.text('Message support on WhatsApp'), findsOneWidget);
    await tester.tap(find.text('Message support on WhatsApp'));
    await tester.pump();
    expect(harness.launcher.openedAddresses, [_expectedAddress]);
  });

  testWidgets('when the phone cannot open it, the sheet offers the number to copy', (tester) async {
    final harness = IdentifyScreenHarness(launcherOpens: false);
    await harness.pump(tester, _button());
    await tester.tap(find.text('Message support on WhatsApp'));
    await tester.pumpAndSettle();
    expect(find.text('Copy number'), findsOneWidget);
    expect(find.text('+260 97 123 4567'), findsOneWidget);
  });

  testWidgets('a number the WhatsApp builder refuses gives no link at all', (tester) async {
    final harness = IdentifyScreenHarness();
    await harness.pump(tester, _button(number: '0971234567'));
    expect(find.text('Message support on WhatsApp'), findsNothing);
    expect(find.byType(TextButton), findsNothing);
  });
}
