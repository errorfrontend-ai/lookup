// Punycode (RFC 3492), the decoding half only: the canonical-link check must refuse an `xn--` host
// label that Node's URL parser refuses, and the parser refuses one that does not decode.

const int _base = 36;
const int _smallestThreshold = 1;
const int _largestThreshold = 26;
const int _skew = 38;
const int _damp = 700;
const int _initialBias = 72;
const int _initialCodePoint = 0x80;
const int _largestCodePoint = 0x10FFFF;

/// The decoder's overflow limit: Node's decoder works in signed 32-bit integers and fails beyond it.
const int _largestSigned32BitInteger = 0x7FFFFFFF;

/// The code points [encoded] stands for (without its `xn--` prefix), or null when it is not valid
/// Punycode: a non-ASCII character, a character that is not a base-36 digit, a sequence that ends
/// in the middle of a number, an overflow, or a result that is not a Unicode scalar value.
///
/// Follows Node's decoder where RFC 3492 leaves room: the last `-` is always the delimiter and is
/// consumed even when nothing comes before it, so `-tda` decodes as `tda` does.
List<int>? decodePunycode(String encoded) {
  final codePoints = <int>[];
  final delimiterIndex = encoded.lastIndexOf('-');
  for (final codeUnit in encoded.substring(0, delimiterIndex < 0 ? 0 : delimiterIndex).codeUnits) {
    if (codeUnit >= 0x80) return null;
    codePoints.add(codeUnit);
  }

  var readIndex = delimiterIndex + 1;
  var codePoint = _initialCodePoint;
  var bias = _initialBias;
  // RFC 3492's "i": the insertion position and the code point's increase, folded into one number.
  var delta = 0;
  while (readIndex < encoded.length) {
    final previousDelta = delta;
    var weight = 1;
    for (var digitLevel = _base; ; digitLevel += _base) {
      if (readIndex >= encoded.length) return null;
      final digit = _digitValue(encoded.codeUnitAt(readIndex));
      readIndex++;
      if (digit == null) return null;
      if (digit > (_largestSigned32BitInteger - delta) ~/ weight) return null;
      delta += digit * weight;
      final threshold = digitLevel <= bias
          ? _smallestThreshold
          : digitLevel >= bias + _largestThreshold
          ? _largestThreshold
          : digitLevel - bias;
      if (digit < threshold) break;
      if (weight > _largestSigned32BitInteger ~/ (_base - threshold)) return null;
      weight *= _base - threshold;
    }
    final lengthAfterInsert = codePoints.length + 1;
    bias = _adaptBias(delta - previousDelta, lengthAfterInsert, isFirstDelta: previousDelta == 0);
    if (delta ~/ lengthAfterInsert > _largestSigned32BitInteger - codePoint) return null;
    codePoint += delta ~/ lengthAfterInsert;
    delta %= lengthAfterInsert;
    if (codePoint > _largestCodePoint || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return null;
    codePoints.insert(delta, codePoint);
    delta++;
  }
  return codePoints;
}

/// RFC 3492 §6.1: scales the bias so the next number's digits are sized to the deltas seen so far.
int _adaptBias(int delta, int codePointCount, {required bool isFirstDelta}) {
  var scaledDelta = isFirstDelta ? delta ~/ _damp : delta ~/ 2;
  scaledDelta += scaledDelta ~/ codePointCount;
  var digitLevel = 0;
  while (scaledDelta > ((_base - _smallestThreshold) * _largestThreshold) ~/ 2) {
    scaledDelta ~/= _base - _smallestThreshold;
    digitLevel += _base;
  }
  return digitLevel + ((_base - _smallestThreshold + 1) * scaledDelta) ~/ (scaledDelta + _skew);
}

/// `a`–`z` (either case) are 0–25 and `0`–`9` are 26–35; anything else is not a digit.
int? _digitValue(int codeUnit) {
  if (codeUnit >= 0x61 && codeUnit <= 0x7A) return codeUnit - 0x61;
  if (codeUnit >= 0x41 && codeUnit <= 0x5A) return codeUnit - 0x41;
  if (codeUnit >= 0x30 && codeUnit <= 0x39) return codeUnit - 0x30 + 26;
  return null;
}
