import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/punycode_decoder.dart';

void main() {
  test('decodes the sample strings of RFC 3492 §7.1 and common labels', () {
    expect(String.fromCharCodes(decodePunycode('mnchen-3ya')!), 'münchen');
    expect(String.fromCharCodes(decodePunycode('bcher-kva')!), 'bücher');
    expect(String.fromCharCodes(decodePunycode('ihqwcrb4cv8a8dqg056pqjye')!), '他们为什么不说中文');
    expect(String.fromCharCodes(decodePunycode('3B-ww4c5e180e575a65lsy2b')!), '3年B組金八先生');
    expect(decodePunycode('egbpdaj6bu4bxfgehfvwxn'), [
      0x0644,
      0x064A,
      0x0647,
      0x0645,
      0x0627,
      0x0628,
      0x062A,
      0x0643,
      0x0644,
      0x0645,
      0x0648,
      0x0634, //
      0x0639, 0x0631, 0x0628, 0x064A, 0x061F,
    ]);
  });

  test(
    'copies the part before the last hyphen as it is, and decodes nothing when nothing follows it',
    () {
      expect(decodePunycode('ab-'), [0x61, 0x62]);
      expect(decodePunycode('a-b-'), [0x61, 0x2D, 0x62]);
      expect(decodePunycode(''), isEmpty);
    },
  );

  test('consumes a delimiter with nothing before it, as Node\'s decoder does', () {
    expect(decodePunycode('-tda'), [0xFC]);
  });

  test(
    'decodes "abc" to three control characters (it is valid Punycode; the link check refuses them)',
    () {
      expect(decodePunycode('abc'), [0x82, 0x81, 0x80]);
    },
  );

  test('reads digits in either case', () {
    expect(String.fromCharCodes(decodePunycode('MNCHEN-3YA')!), 'MüNCHEN');
  });

  test('gives nothing for input that is not Punycode', () {
    for (final encoded in [
      'zz', // ends in the middle of a number
      'ab!', // not a base-36 digit
      'ü-tda', // a non-ASCII character before the delimiter
      '999999999999', // a number too large for the decoder
      'bb00k', // a code point beyond U+10FFFF
      'bb0c', // a code point among the surrogates (U+DCC2)
    ]) {
      expect(decodePunycode(encoded), isNull, reason: encoded);
    }
  });
}
