// Plain `test`s with no Flutter binding: the builder is a pure function (S4-LINKS-01).
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/canonical_https_link.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

import '../../../support/contract_fixtures.dart';

void main() {
  group('the shared address fixtures (action-card/action-uris.json)', () {
    final cases = ContractFixtures.readFile('action-card/action-uris.json') as List<Object?>;

    test('the loader finds all 11 address cases', () {
      expect(cases, hasLength(11));
    });

    for (final fixtureCase in cases.cast<Map<String, Object?>>()) {
      test('${fixtureCase['description']}', () {
        // As the TypeScript test does: the action goes through the reader first, as on the phone.
        final readCard = readActionCard({
          'schema_version': 1,
          'layout': 'VERTICAL_STACK',
          'actions': [fixtureCase['action']],
        });
        final readAction = readCard.visibleActions.firstOrNull;
        expect(readAction == null ? null : buildActionUri(readAction), fixtureCase['expected_uri']);
      });
    }
  });

  group('WhatsApp text', () {
    test(
      'a text that cannot be encoded (a lone surrogate) gives no address rather than an error',
      () {
        for (final text in ['Hi \uD800 there', 'Hi \uDC00 there', 'ends with a high half \uD83D']) {
          expect(() => buildActionUri(_whatsApp(text)), returnsNormally);
          expect(buildActionUri(_whatsApp(text)), isNull, reason: text);
        }
        expect(buildActionUri(_whatsApp('Hi there')), 'https://wa.me/260966123456?text=Hi%20there');
      },
    );

    test('an empty text gives the plain chat address, as the TypeScript builder does', () {
      expect(buildActionUri(_whatsApp('')), 'https://wa.me/260966123456');
      expect(buildActionUri(_whatsApp(null)), 'https://wa.me/260966123456');
    });

    test(
      'the text is encoded as encodeURIComponent encodes it: only letters, digits and -_.!~*\'() are kept',
      () {
        const keptAsWritten = "-_.!~*'()";
        for (var codeUnit = 0x00; codeUnit <= 0x7F; codeUnit++) {
          final character = String.fromCharCode(codeUnit);
          final isKept =
              RegExp('[A-Za-z0-9]').hasMatch(character) || keptAsWritten.contains(character);
          final expectedText = isKept
              ? character
              : '%${codeUnit.toRadixString(16).toUpperCase().padLeft(2, '0')}';
          expect(
            buildActionUri(_whatsApp('a${character}b')),
            'https://wa.me/260966123456?text=a${expectedText}b',
            reason: 'U+${codeUnit.toRadixString(16)}',
          );
        }
      },
    );

    test('text beyond ASCII is encoded as UTF-8, a pair of surrogates as one character', () {
      expect(buildActionUri(_whatsApp('é')), 'https://wa.me/260966123456?text=%C3%A9');
      expect(buildActionUri(_whatsApp('\u0085')), 'https://wa.me/260966123456?text=%C2%85');
      expect(buildActionUri(_whatsApp('😀')), 'https://wa.me/260966123456?text=%F0%9F%98%80');
    });
  });

  group('map coordinates', () {
    test('minus zero prints without a sign, as JavaScript\'s toFixed prints it', () {
      expect(buildActionUri(_map(-0.0, -0.0)), '${mapDirectionsAddressPrefix}0.000000%2C0.000000');
    });

    test(
      'a tiny negative number that rounds to zero keeps its sign, as JavaScript\'s toFixed does',
      () {
        expect(
          buildActionUri(_map(-0.0000001, 28)),
          '$mapDirectionsAddressPrefix-0.000000%2C28.000000',
        );
      },
    );

    test('a value exactly halfway rounds away from zero, as JavaScript\'s toFixed does', () {
      expect(
        buildActionUri(_map(0.0078125, -0.0078125)),
        '${mapDirectionsAddressPrefix}0.007813%2C-0.007813',
      );
    });

    test('a coordinate that is not finite, or out of range, gives no address', () {
      for (final coordinates in [
        (double.nan, 28.0),
        (-15.0, double.infinity),
        (-15.0, double.negativeInfinity),
        (90.0000001, 28.0),
        (-15.0, -180.0000001),
      ]) {
        expect(
          buildActionUri(_map(coordinates.$1, coordinates.$2)),
          isNull,
          reason: '$coordinates',
        );
      }
    });
  });

  group('actions made directly, without the reader, are checked again', () {
    test('a call or WhatsApp number that is not E.164 gives no address', () {
      for (final phoneNumber in [
        '0977123456',
        '+260 977 123 456',
        'tel:+260977123456',
        '+0977123456',
        '',
      ]) {
        expect(buildActionUri(_call(phoneNumber)), isNull, reason: phoneNumber);
        expect(
          buildActionUri(_whatsApp(null, phoneNumber: phoneNumber)),
          isNull,
          reason: phoneNumber,
        );
      }
    });

    test('a link that is not a canonical https link gives no address', () {
      for (final link in [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'http://example.com/offer',
        'https://Example.com/offer',
        'https://example.com',
        'intent://scan/#Intent;scheme=zxing;end',
        'file:///etc/passwd',
      ]) {
        expect(buildActionUri(_link(link)), isNull, reason: link);
      }
      expect(buildActionUri(_link('https://example.com/offer')), 'https://example.com/offer');
    });
  });

  test('hostile cards only ever give the allowed beginnings of an address (S4-LINKS-12)', () {
    final hostileActions = <Map<String, Object?>>[
      {'type': 'CALL', 'phone_number_e164': '+260977123456', 'url': 'javascript:alert(1)'},
      {'type': 'CALL', 'phone_number_e164': 'javascript:alert(1)'},
      {'type': 'CALL', 'phone_number_e164': '+260977123456\njavascript:alert(1)'},
      {
        'type': 'WHATSAPP',
        'phone_number_e164': '+260966123456',
        'prefilled_text': '&url=javascript:alert(1)#x',
      },
      {'type': 'WHATSAPP', 'phone_number_e164': '+260966123456/../evil'},
      {'type': 'MAP', 'latitude': 1e300, 'longitude': 28},
      {'type': 'MAP', 'latitude': -15, 'longitude': 28, 'url': 'https://evil.example/'},
      {'type': 'LINK', 'url': 'JavaScript:alert(1)'},
      {'type': 'LINK', 'url': 'https://example.com/\\\\evil.example'},
      {'type': 'LINK', 'url': 'https://example.com@evil.example/'},
      {'type': 'LINK', 'url': 'https://evil.example/\u202Egnp.exe'},
      {'type': 'LINK', 'url': ' https://example.com/'},
    ];
    for (final hostileAction in hostileActions) {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [
          {'id': 'hostile', 'label': 'Tap me', ...hostileAction},
        ],
      });
      for (final action in readCard.shownActions) {
        final address = buildActionUri(action);
        final isAllowed = switch (action) {
          CallUiAction() =>
            address != null && RegExp(r'^tel:\+[1-9][0-9]{6,14}$').hasMatch(address),
          WhatsAppUiAction() => address != null && address.startsWith(whatsAppAddressPrefix),
          MapUiAction() => address != null && address.startsWith(mapDirectionsAddressPrefix),
          LinkUiAction() => address != null && isCanonicalHttpsLink(address),
        };
        expect(isAllowed, isTrue, reason: '$hostileAction gave $address');
      }
    }
  });
}

CallUiAction _call(String phoneNumber) => CallUiAction(
  id: 'call',
  label: 'Call us',
  style: ActionStyle.primary,
  phoneNumberE164: phoneNumber,
);

WhatsAppUiAction _whatsApp(String? prefilledText, {String phoneNumber = '+260966123456'}) =>
    WhatsAppUiAction(
      id: 'chat',
      label: 'WhatsApp us',
      style: ActionStyle.secondary,
      phoneNumberE164: phoneNumber,
      prefilledText: prefilledText,
    );

MapUiAction _map(double latitude, double longitude) => MapUiAction(
  id: 'shop',
  label: 'Find our shop',
  style: ActionStyle.outline,
  latitude: latitude,
  longitude: longitude,
);

LinkUiAction _link(String link) =>
    LinkUiAction(id: 'menu', label: 'See the menu', style: ActionStyle.outline, link: link);
