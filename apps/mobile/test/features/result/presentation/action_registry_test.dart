import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/action_button_list.dart';
import 'package:lookup_listener/features/result/presentation/action_registry.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';

import '../support/result_screen_harness.dart';

const CallUiAction _call = CallUiAction(
  id: 'call',
  label: 'Call us',
  style: ActionStyle.primary,
  phoneNumberE164: '+260977123456',
);
const WhatsAppUiAction _whatsApp = WhatsAppUiAction(
  id: 'whatsapp',
  label: 'WhatsApp us',
  style: ActionStyle.secondary,
  phoneNumberE164: '+260966123456',
  prefilledText: 'Hi, I heard your ad',
);
const MapUiAction _map = MapUiAction(
  id: 'map',
  label: 'Find our shop',
  style: ActionStyle.outline,
  latitude: -15.4167,
  longitude: 28.2833,
);
const LinkUiAction _link = LinkUiAction(
  id: 'link',
  label: 'See the menu',
  style: ActionStyle.outline,
  link: 'https://example.co.zm/menu',
);

void main() {
  const registry = ActionRegistry.standard;

  test('has exactly four registrations: call, WhatsApp, map and link (S4-RENDERER-02, -03)', () {
    expect(registry.registrations.map((registration) => registration.actionType), [
      CallUiAction,
      WhatsAppUiAction,
      MapUiAction,
      LinkUiAction,
    ]);
  });

  test('each type finds its own registration, which serves no other type', () {
    for (final action in const <UiAction>[_call, _whatsApp, _map, _link]) {
      final registration = registry.registrationFor(action)!;
      expect(registration.actionType, action.runtimeType);
      final otherActions = const <UiAction>[
        _call,
        _whatsApp,
        _map,
        _link,
      ].where((other) => other.runtimeType != action.runtimeType);
      for (final other in otherActions) {
        expect(registration.serves(other), isFalse);
        expect(registration.buildAddress(other), isNull);
        expect(registration.buildCopyOffer(other, 'tel:+260977123456'), isNull);
      }
    }
  });

  test('each address builder is the domain builder: the address the button opens', () {
    for (final action in const <UiAction>[_call, _whatsApp, _map, _link]) {
      final address = registry.registrationFor(action)!.buildAddress(action);
      expect(address, isNotNull);
      expect(address, buildActionUri(action));
    }
    expect(registry.registrationFor(_call)!.buildAddress(_call), 'tel:+260977123456');
    expect(
      registry.registrationFor(_map)!.buildAddress(_map),
      'https://www.google.com/maps/dir/?api=1&destination=-15.416700%2C28.283300',
    );
  });

  test('call and WhatsApp offer their E.164 number to copy; map and link their address', () {
    final callOffer = registry.registrationFor(_call)!.buildCopyOffer(_call, 'tel:+260977123456');
    expect(callOffer, isA<PhoneNumberCopyOffer>());
    expect(callOffer!.copiedText, '+260977123456');

    final whatsAppAddress = buildActionUri(_whatsApp)!;
    final whatsAppOffer = registry
        .registrationFor(_whatsApp)!
        .buildCopyOffer(_whatsApp, whatsAppAddress);
    expect(whatsAppOffer, isA<PhoneNumberCopyOffer>());
    expect(whatsAppOffer!.copiedText, '+260966123456');

    for (final action in const <UiAction>[_map, _link]) {
      final address = buildActionUri(action)!;
      final offer = registry.registrationFor(action)!.buildCopyOffer(action, address);
      expect(offer, isA<LinkCopyOffer>());
      expect(offer!.copiedText, address);
    }
  });

  test('a link that is not canonical https has no address, so its button opens nothing', () {
    const javaScriptLink = LinkUiAction(
      id: 'link',
      label: 'See the menu',
      style: ActionStyle.outline,
      link: 'javascript:alert(1)',
    );
    expect(registry.registrationFor(javaScriptLink)!.buildAddress(javaScriptLink), isNull);
  });

  testWidgets('each type draws its icon: a phone, a speech bubble, a map pin and a globe', (
    tester,
  ) async {
    await ResultScreenHarness().pump(
      tester,
      Scaffold(
        body: Column(
          children: [
            for (final action in const <UiAction>[_call, _whatsApp, _map, _link])
              registry
                  .registrationFor(action)!
                  .buildButton(action, showsIcon: true, onPressed: () {}),
          ],
        ),
      ),
    );

    for (final (label, icon) in [
      ('Call us', Icons.call_outlined),
      ('WhatsApp us', Icons.chat_bubble_outline),
      ('Find our shop', Icons.location_on_outlined),
      ('See the menu', Icons.language),
    ]) {
      final button = find.ancestor(of: find.text(label), matching: find.byType(ActionButton));
      expect(find.descendant(of: button, matching: find.byIcon(icon)), findsOneWidget);
    }
  });

  testWidgets('without room for icons, the same buttons have none', (tester) async {
    await ResultScreenHarness().pump(
      tester,
      Scaffold(
        body: registry
            .registrationFor(_call)!
            .buildButton(_call, showsIcon: false, onPressed: () {}),
      ),
    );
    expect(find.byType(Icon), findsNothing);
    expect(find.text('Call us'), findsOneWidget);
  });

  testWidgets('style picks the variant: FilledButton, FilledButton.tonal, OutlinedButton', (
    tester,
  ) async {
    final colours = LookUpTokens.light.colours;
    await ResultScreenHarness().pump(
      tester,
      Scaffold(
        body: ActionButtonList(
          card: readActionCard(
            cardOf([
              callAction('0192a6c4-0000-4000-8000-000000000001', 'Primary', style: 'PRIMARY'),
              callAction('0192a6c4-0000-4000-8000-000000000002', 'Secondary', style: 'SECONDARY'),
              callAction('0192a6c4-0000-4000-8000-000000000003', 'Outline', style: 'OUTLINE'),
            ]),
          ),
          showsIcons: true,
        ),
      ),
    );

    Color? fillOf(String label, Type buttonType) {
      final button = find.ancestor(of: find.text(label), matching: find.byType(buttonType));
      expect(button, findsOneWidget, reason: '"$label" is not a $buttonType');
      return tester
          .widget<Material>(find.descendant(of: button, matching: find.byType(Material)).first)
          .color;
    }

    expect(fillOf('Primary', FilledButton), colours.accent);
    expect(fillOf('Secondary', FilledButton), colours.accentSoft);
    expect(fillOf('Outline', OutlinedButton), colours.surface);
  });

  testWidgets('a vertical stack is one column, one button per row', (tester) async {
    await ResultScreenHarness().pump(
      tester,
      Scaffold(body: ActionButtonList(card: readActionCard(fourActionCard), showsIcons: true)),
    );

    final column = find.descendant(
      of: find.byType(ActionButtonList),
      matching: find.byType(Column),
    );
    expect(column, findsOneWidget);
    final buttons = find.byType(ActionButton);
    expect(buttons, findsNWidgets(4));
    final rects = [for (var index = 0; index < 4; index++) tester.getRect(buttons.at(index))];
    for (var index = 1; index < rects.length; index++) {
      expect(rects[index].left, rects[0].left);
      expect(rects[index].top, greaterThan(rects[index - 1].bottom));
    }
  });

  testWidgets('a card with call, ACTION_SHOP and link shows two buttons and throws nothing', (
    tester,
  ) async {
    final card = cardOf([
      callAction('0192a6c4-0000-4000-8000-000000000001', 'Call us'),
      {
        'type': 'ACTION_SHOP',
        'id': '0192a6c4-0000-4000-8000-000000000002',
        'label': 'Shop now',
        'style': 'PRIMARY',
      },
      {
        'type': 'LINK',
        'id': '0192a6c4-0000-4000-8000-000000000003',
        'label': 'See the menu',
        'style': 'OUTLINE',
        'url': 'https://example.co.zm/menu',
      },
    ]);
    await ResultScreenHarness().pump(
      tester,
      Scaffold(body: ActionButtonList(card: readActionCard(card), showsIcons: true)),
    );

    expect(tester.takeException(), isNull);
    expect(find.byType(ActionButton), findsNWidgets(2));
    expect(find.text('Call us'), findsOneWidget);
    expect(find.text('See the menu'), findsOneWidget);
    expect(find.text('Shop now'), findsNothing);
  });

  testWidgets(
    'an action with no registration is skipped, and the rest still show (S4-RENDERER-05)',
    (tester) async {
      final callOnly = ActionRegistry([registry.registrationFor(_call)!]);
      await ResultScreenHarness().pump(
        tester,
        Scaffold(
          body: ActionButtonList(
            card: readActionCard(fourActionCard),
            showsIcons: true,
            registry: callOnly,
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.byType(ActionButton), findsOneWidget);
      expect(find.text('Call us'), findsOneWidget);
    },
  );
}
