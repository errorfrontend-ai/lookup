import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/canonical_https_link.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

import '../../../support/contract_fixtures.dart';

void main() {
  group(
    'the shared reader fixtures (action-card/reader), read as the TypeScript test reads them',
    () {
      final fixtures = ContractFixtures.readFolder('action-card/reader');

      test('the loader finds all 18 reader fixtures', () {
        expect(fixtures, hasLength(18));
      });

      for (final fixture in fixtures) {
        test(fixture.name, () {
          final content = fixture.content as Map<String, Object?>;
          expect(_summaryOf(readActionCard(content['card'])), content['expected']);
        });
      }
    },
  );

  group('the shared valid cards (action-card/valid)', () {
    final fixtures = ContractFixtures.readFolder('action-card/valid');

    test('the loader finds all 13 valid cards', () {
      expect(fixtures, hasLength(13));
    });

    for (final fixture in fixtures) {
      test(
        '${fixture.name}: every action is shown, nothing is skipped, and every button opens an allowed address',
        () {
          final card = (fixture.content as Map<String, Object?>)['card'] as Map<String, Object?>;
          final readCard = readActionCard(card);
          expect(readCard.shownActions, hasLength((card['actions'] as List<Object?>).length));
          expect(readCard.shownActions.length, lessThanOrEqualTo(maximumActionsPerCard));
          expect(readCard.visibleActions.length, lessThanOrEqualTo(actionsShownBeforeMoreOptions));
          expect(readCard.skippedUnknownTypeCount, 0);
          expect(readCard.skippedInvalidCount, 0);
          expect(readCard.showsUpdateAppHint, isFalse);
          for (final action in readCard.shownActions) {
            expect(_isAllowedAddress(action, buildActionUri(action)), isTrue, reason: action.id);
          }
        },
      );
    }
  });

  group('the shared invalid cards (action-card/invalid)', () {
    final fixtures = ContractFixtures.readFolder('action-card/invalid');

    test('the loader finds all 38 invalid cards, and each has an expected reading below', () {
      expect(fixtures, hasLength(38));
      expect(fixtures.map((fixture) => fixture.name).toSet(), _invalidCardReadings.keys.toSet());
    });

    for (final fixture in fixtures) {
      final expected = _invalidCardReadings[fixture.name];
      test(
        '${fixture.name}: read without an error, as the shared reader reads it, opening only allowed addresses',
        () {
          final card = (fixture.content as Map<String, Object?>)['card'];
          final readCard = readActionCard(card);
          expect((
            shown: readCard.shownActions.length,
            unknown: readCard.skippedUnknownTypeCount,
            invalid: readCard.skippedInvalidCount,
            hint: readCard.showsUpdateAppHint,
          ), expected);
          for (final action in readCard.shownActions) {
            expect(_isAllowedAddress(action, buildActionUri(action)), isTrue, reason: action.id);
          }
        },
      );
    }
  });

  group('the traps between JavaScript and Dart that the shared fixtures pin', () {
    test(
      'a schema version written as 1.0 decodes to a Dart double and still reads as version 1',
      () {
        const fileName = 'action-card/reader/schema-version-written-as-one-point-zero.json';
        expect(ContractFixtures.readText(fileName), contains('"schema_version": 1.0,'));
        final card =
            (ContractFixtures.readFile(fileName) as Map<String, Object?>)['card']
                as Map<String, Object?>;
        expect(card['schema_version'], isA<double>());
        expect(readActionCard(card).visibleActions, hasLength(1));
      },
    );

    test('a label of only U+0085 is shown, although Dart\'s own trim() would make it blank', () {
      final readCard = readActionCard(
        _cardFromFixture('action-card/reader/label-only-next-line-character-still-shown.json'),
      );
      expect(readCard.visibleActions.map((action) => action.label), ['\u0085']);
      expect('\u0085'.trim(), isEmpty, reason: 'the trap is still there in Dart');
    });

    test('a latitude of -0.0 is kept as minus zero', () {
      final readCard = readActionCard(
        _cardFromFixture('action-card/reader/map-latitude-minus-zero-still-shown.json'),
      );
      final mapAction = readCard.visibleActions.single as MapUiAction;
      expect(mapAction.latitude, 0);
      expect(mapAction.latitude.isNegative, isTrue);
    });
  });

  group('the reader never throws (rule R9)', () {
    final notCards = <Object?>[
      null,
      0,
      'text',
      <Object?>[],
      <String, Object?>{},
      {'actions': 'x'},
      {'schema_version': '1'},
      {'schema_version': 1.5},
      {'schema_version': double.nan},
      {'schema_version': double.infinity},
      {'schema_version': 1, 'actions': null},
      {
        'schema_version': 1,
        'actions': [
          null,
          true,
          <Object?>[],
          {'type': null},
          {'type': 'MAP', 'id': 'a', 'label': 'b', 'latitude': double.nan, 'longitude': 0},
          {'type': 'CALL', 'id': 7, 'label': 'b', 'phone_number_e164': '+260977123456'},
          {1: 'a key that is not text'},
        ],
      },
    ];
    for (final notCard in notCards) {
      test('given ${jsonEncode(notCard, toEncodable: (value) => '$value')}', () {
        expect(() => readActionCard(notCard), returnsNormally);
      });
    }
  });

  group('rules the shared fixtures do not cover', () {
    test(
      'a schema version written as text, missing, or with a fraction shows no buttons and the update hint',
      () {
        for (final schemaVersion in <Object?>['1', null, 1.5, true]) {
          final readCard = readActionCard({
            'schema_version': schemaVersion,
            'actions': [_callAction()],
          });
          expect(readCard.shownActions, isEmpty, reason: '$schemaVersion');
          expect(readCard.showsUpdateAppHint, isTrue, reason: '$schemaVersion');
        }
      },
    );

    test('an older schema version is read normally, as the shared reader reads it', () {
      expect(
        readActionCard({
          'schema_version': 0,
          'actions': [_callAction()],
        }).visibleActions,
        hasLength(1),
      );
    });

    test('a reader that supports version 2 reads a version 2 card', () {
      final card = {
        'schema_version': 2,
        'actions': [_callAction()],
      };
      expect(readActionCard(card).showsUpdateAppHint, isTrue);
      expect(readActionCard(card, supportedSchemaVersion: 2).visibleActions, hasLength(1));
    });

    test(
      'a card with no actions list, or actions that are not a list, is an empty card with no hint',
      () {
        for (final actions in <Object?>[null, 'x', 3, <String, Object?>{}]) {
          final readCard = readActionCard({'schema_version': 1, 'actions': actions});
          expect(
            _summaryOf(readCard),
            _emptySummary(showsUpdateAppHint: false),
            reason: '$actions',
          );
        }
      },
    );

    test('any layout, or none, reads as a vertical stack', () {
      for (final layout in <Object?>['GRID', 'CAROUSEL', null, 4]) {
        expect(
          readActionCard({
            'schema_version': 1,
            'layout': layout,
            'actions': [_callAction()],
          }).layout,
          ActionCardLayout.verticalStack,
        );
      }
    });

    test('a type that is not text is invalid, so it never shows the update hint', () {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [
          {..._callAction(), 'type': 5},
        ],
      });
      expect(_summaryOf(readCard)['skipped_invalid_count'], 1);
      expect(readCard.showsUpdateAppHint, isFalse);
    });

    test('a known type written in lower case is an unknown type', () {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [
          {..._callAction(), 'type': 'call'},
        ],
      });
      expect(readCard.skippedUnknownTypeCount, 1);
      expect(readCard.showsUpdateAppHint, isTrue);
    });

    test(
      'the update hint shows when nothing is shown and one action was unknown, even beside invalid ones',
      () {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [
            {..._callAction(), 'type': 'ACTION_SHOP'},
            {..._callAction(), 'phone_number_e164': '0977123456'},
          ],
        });
        expect(readCard.shownActions, isEmpty);
        expect(readCard.showsUpdateAppHint, isTrue);
      },
    );

    test('a duplicate id takes none of the six places and is not counted as skipped', () {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [
          _callAction(id: 'first'),
          _callAction(id: 'first', label: 'The duplicate'),
          for (final id in ['2', '3', '4', '5', '6', '7']) _callAction(id: id),
        ],
      });
      expect(readCard.visibleActions.map((action) => action.id), ['first', '2', '3', '4']);
      expect(readCard.moreOptionsActions.map((action) => action.id), ['5', '6']);
      expect(readCard.visibleActions.first.label, 'Call us');
      expect(readCard.skippedInvalidCount, 0);
      expect(readCard.skippedUnknownTypeCount, 0);
    });

    test('the lists of actions cannot be changed by the screen', () {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [_callAction()],
      });
      expect(
        () => readCard.visibleActions.add(readCard.visibleActions.first),
        throwsUnsupportedError,
      );
      expect(() => readCard.moreOptionsActions.clear(), throwsUnsupportedError);
    });

    test('an extra url on a call action is never read', () {
      final readCard = readActionCard({
        'schema_version': 1,
        'actions': [
          {..._callAction(), 'url': 'javascript:alert(1)'},
        ],
      });
      final action = readCard.visibleActions.single;
      expect(action, isA<CallUiAction>());
      expect(buildActionUri(action), 'tel:+260977123456');
    });

    test('each style is read, and an unknown, missing or non-text style reads as secondary', () {
      ActionStyle styleOf(Object? style) => readActionCard({
        'schema_version': 1,
        'actions': [
          {..._callAction(), 'style': style},
        ],
      }).visibleActions.single.style;
      expect(styleOf('PRIMARY'), ActionStyle.primary);
      expect(styleOf('SECONDARY'), ActionStyle.secondary);
      expect(styleOf('OUTLINE'), ActionStyle.outline);
      for (final style in <Object?>['primary', 'GHOST', null, 1]) {
        expect(styleOf(style), ActionStyle.secondary, reason: '$style');
      }
    });

    test('every character JavaScript trims makes a blank label, and the action is skipped', () {
      const javaScriptWhitespace =
          '\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007'
          '\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
      for (final character in javaScriptWhitespace.split('')) {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [_callAction(label: '$character$character')],
        });
        expect(
          readCard.skippedInvalidCount,
          1,
          reason: 'U+${character.codeUnitAt(0).toRadixString(16)}',
        );
      }
    });

    test(
      'characters JavaScript does not trim make a label that is shown (U+0085, U+180E, U+200B)',
      () {
        for (final label in ['\u0085', '\u180E', '\u200B']) {
          final readCard = readActionCard({
            'schema_version': 1,
            'actions': [_callAction(label: label)],
          });
          expect(readCard.visibleActions.single.label, label);
        }
      },
    );

    test('a missing, blank or non-text id or label skips the action', () {
      for (final broken in <Map<String, Object?>>[
        {'id': null},
        {'id': '   '},
        {'id': 12},
        {'label': null},
        {'label': ''},
        {'label': 12},
      ]) {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [
            {..._callAction(), ...broken},
          ],
        });
        expect(readCard.skippedInvalidCount, 1, reason: '$broken');
      }
    });

    test(
      'a phone number with a line break after it is refused, as JavaScript\'s pattern refuses it',
      () {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [_callAction(phoneNumber: '+260977123456\n')],
        });
        expect(readCard.skippedInvalidCount, 1);
      },
    );

    test('a blank or non-text prefilled text is dropped and the WhatsApp button kept', () {
      for (final prefilledText in <Object?>['', '  \n', 42, null]) {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [
            {
              'type': 'WHATSAPP',
              'id': 'chat',
              'label': 'WhatsApp us',
              'phone_number_e164': '+260966123456',
              'prefilled_text': prefilledText,
            },
          ],
        });
        final action = readCard.visibleActions.single as WhatsAppUiAction;
        expect(action.prefilledText, isNull, reason: '$prefilledText');
        expect(buildActionUri(action), 'https://wa.me/260966123456');
      }
    });

    test('a blank or non-text place name is dropped and the map button kept', () {
      for (final placeName in <Object?>['', '\u3000', false]) {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [
            {
              'type': 'MAP',
              'id': 'shop',
              'label': 'Find us',
              'latitude': -15,
              'longitude': 28,
              'place_name': placeName,
            },
          ],
        });
        expect(
          (readCard.visibleActions.single as MapUiAction).placeName,
          isNull,
          reason: '$placeName',
        );
      }
    });

    test('a coordinate that is not a number, or not finite, skips the map button', () {
      for (final coordinates in <(Object?, Object?)>[
        (true, 28),
        (-15, '28'),
        (null, 28),
        (double.nan, 28),
        (-15, double.negativeInfinity),
        (-90.000001, 28),
        (-15, 180.000001),
      ]) {
        final readCard = readActionCard({
          'schema_version': 1,
          'actions': [
            {
              'type': 'MAP',
              'id': 'shop',
              'label': 'Find us',
              'latitude': coordinates.$1,
              'longitude': coordinates.$2,
            },
          ],
        });
        expect(readCard.skippedInvalidCount, 1, reason: '$coordinates');
      }
    });
  });
}

/// What the reader makes of each card the contract's schema refuses. The schema is stricter than the
/// reader (ids need not be UUIDs, labels need not be short, shorteners are not the reader's business),
/// so many are read normally; those whose fields the reader cannot use are skipped. These are the
/// answers the shared TypeScript reader gives for the same files (checked on 8 October 2026).
const Map<String, ({int shown, int unknown, int invalid, bool hint})> _invalidCardReadings = {
  'data-scheme-link': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'duplicate-action-ids': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'http-link': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'id-not-uuid': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'javascript-scheme-link': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'label-33-characters': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'label-bidirectional-override': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'label-empty': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'label-leading-space': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'label-with-line-break': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'latitude-91': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'latitude-as-string': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-2049-characters': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'link-ip-address-host': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-localhost': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-not-canonical': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-unicode-host-not-punycode': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-url-shortener': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'link-with-credentials': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-with-port': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'link-with-space': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'local-phone-number': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'longitude-181': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'map-zero-zero': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'missing-id': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'missing-style': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'no-actions': (shown: 0, unknown: 0, invalid: 0, hint: false),
  'phone-tel-scheme': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'phone-with-spaces': (shown: 0, unknown: 0, invalid: 1, hint: false),
  'prefilled-text-501': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'prefilled-text-tab': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'schema-version-2': (shown: 0, unknown: 0, invalid: 0, hint: true),
  'seven-actions': (shown: 6, unknown: 0, invalid: 0, hint: false),
  'unknown-action-type': (shown: 0, unknown: 1, invalid: 0, hint: true),
  'unknown-field-on-action': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'unknown-field-on-card': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'unknown-style': (shown: 1, unknown: 0, invalid: 0, hint: false),
  'zambian-number-ten-digits': (shown: 1, unknown: 0, invalid: 0, hint: false),
};

/// The read card in the shape of a reader fixture's `expected`.
Map<String, Object?> _summaryOf(ReadActionCard readCard) => {
  'visible_action_ids': [for (final action in readCard.visibleActions) action.id],
  'more_options_action_ids': [for (final action in readCard.moreOptionsActions) action.id],
  'styles': [for (final action in readCard.shownActions) action.style.wireName],
  'skipped_unknown_type_count': readCard.skippedUnknownTypeCount,
  'skipped_invalid_count': readCard.skippedInvalidCount,
  'shows_update_app_hint': readCard.showsUpdateAppHint,
};

Map<String, Object?> _emptySummary({required bool showsUpdateAppHint}) =>
    _summaryOf(ReadActionCard.empty(showsUpdateAppHint: showsUpdateAppHint));

Object? _cardFromFixture(String relativePath) =>
    (ContractFixtures.readFile(relativePath) as Map<String, Object?>)['card'];

Map<String, Object?> _callAction({
  String id = 'call',
  String label = 'Call us',
  String phoneNumber = '+260977123456',
}) => {
  'type': 'CALL',
  'id': id,
  'label': label,
  'style': 'PRIMARY',
  'phone_number_e164': phoneNumber,
};

/// The only addresses a button may ever open (S4-LINKS-12).
bool _isAllowedAddress(UiAction action, String? address) {
  if (address == null) return false;
  return switch (action) {
    CallUiAction() => address.startsWith('tel:+'),
    WhatsAppUiAction() => address.startsWith(whatsAppAddressPrefix),
    MapUiAction() => address.startsWith(mapDirectionsAddressPrefix),
    LinkUiAction(:final link) => address == link && isCanonicalHttpsLink(address),
  };
}
