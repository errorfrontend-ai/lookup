import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/canonical_https_link.dart';

import '../../../support/contract_fixtures.dart';

void main() {
  group('the shared canonical-link cases (action-card/canonical-links.json), answered by Node', () {
    final cases = (ContractFixtures.readFile('action-card/canonical-links.json') as List<Object?>)
        .cast<Map<String, Object?>>();

    test('the loader finds all 54 link cases', () {
      expect(cases, hasLength(54));
    });

    for (final linkCase in cases) {
      test('${linkCase['description']}', () {
        expect(
          isCanonicalHttpsLink(linkCase['link']! as String),
          linkCase['is_canonical'],
          reason: '${linkCase['link']}',
        );
      });
    }
  });

  group('rules the shared cases do not cover (answers measured with Node 24 on 8 October 2026)', () {
    final answers = <String, bool>{
      // A "#" inside the fragment and a "?" inside the query or fragment are left as written.
      'https://example.com/offer#a#b': true,
      'https://example.com/offer?a?b': true,
      'https://example.com/offer#?x': true,
      // Dot segments, in every spelling and position.
      'https://example.com/offer/%2e./terms': false,
      'https://example.com/offer/.': false,
      'https://example.com/%2E': false,
      'https://example.com/%2e%2e': false,
      'https://example.com/a/..b/c': true,
      // Kept as written: a double slash, an encoded backslash, an escape that is not hex, encoded spaces.
      'https://example.com//offer': true,
      'https://example.com/offer%5Cterms': true,
      'https://example.com/offer?q=%zz': true,
      'https://example.com/offer?q=a%20b#x%20y': true,
      // Hosts: a punycode top-level label, several labels, hyphens inside a label, a trailing dot.
      'https://example.xn--p1ai/': true,
      'https://xn--tda.xn--wgv71a.com/': true,
      'https://a.b.c.d.example.com/': true,
      'https://ex--ample.com/': true,
      'https://example.com./offer': false,
      // Characters outside printable ASCII are refused by the contract's pattern.
      'https://example.com/café': false,
      'https://example.com/offer?q=café': false,
      'https://example.com/off\ter': false,
    };
    for (final MapEntry(key: link, value: isCanonical) in answers.entries) {
      test('$link is ${isCanonical ? '' : 'not '}canonical', () {
        expect(isCanonicalHttpsLink(link), isCanonical);
      });
    }
  });

  group(
    'international hosts: an xn-- label is canonical only when Node accepts what it decodes to',
    () {
      // Each label is Punycode for the text named; Node's answers measured with Node 24 on 8 October 2026.
      final answers = <String, ({String decodesTo, bool isCanonical})>{
        'xn--tda': (decodesTo: 'ü', isCanonical: true),
        'xn--wgv71a': (decodesTo: 'Japanese 日本', isCanonical: true),
        'xn--mgbh0fb': (decodesTo: 'Arabic مثال', isCanonical: true),
        'xn--e1afmkfd': (decodesTo: 'Cyrillic пример', isCanonical: true),
        'xn--mxa8a': (decodesTo: 'Greek with a final sigma ας', isCanonical: true),
        'xn--strae-oqa': (decodesTo: 'straße', isCanonical: true),
        'xn--e28h': (decodesTo: 'an emoji 😀', isCanonical: true),
        'xn---tda': (
          decodesTo: 'ü, with a delimiter that has nothing before it',
          isCanonical: true,
        ),
        'xn--a': (decodesTo: 'U+0080, a control character', isCanonical: false),
        'xn---abc': (decodesTo: 'three control characters', isCanonical: false),
        'xn--wca': (decodesTo: 'a capital Ü', isCanonical: false),
        'xn--a-cka': (decodesTo: 'a capital İ with a dot', isCanonical: false),
        'xn--22g': (decodesTo: 'the ohm sign, which the table maps to ω', isCanonical: false),
        'xn--ab-5da': (decodesTo: 'a soft hyphen', isCanonical: false),
        'xn--a-wbb': (decodesTo: 'a combining accent first', isCanonical: false),
        'xn--b-yq0i': (decodesTo: 'a full-width letter', isCanonical: false),
        'xn--ab-m1t': (decodesTo: 'a zero-width joiner', isCanonical: false),
        'xn--a-ro7g': (decodesTo: 'a private-use character', isCanonical: false),
        'xn--ab-1ca': (decodesTo: 'a no-break space', isCanonical: false),
        'xn--ab-r13a': (decodesTo: 'an ideographic full stop', isCanonical: false),
        'xn--ab-ot3n': (decodesTo: 'a byte order mark', isCanonical: false),
        'xn--a-i89h': (decodesTo: 'a variation selector', isCanonical: false),
        'xn--ab-q8t': (decodesTo: 'a word joiner', isCanonical: false),
        'xn--zz': (decodesTo: 'nothing: it ends in the middle of a number', isCanonical: false),
      };
      for (final MapEntry(key: label, value: answer) in answers.entries) {
        test('$label (${answer.decodesTo}) is ${answer.isCanonical ? '' : 'not '}canonical', () {
          expect(isCanonicalHttpsLink('https://$label.com/offer'), answer.isCanonical);
        });
      }
    },
  );
}
