import 'dart:math';

/// Makes random version-4 UUIDs (RFC 9562) for the install id, every request's `X-Request-Id` and
/// each clip's idempotency key (design §3.8, §3.9, S4-D9). They come from the operating system's
/// secure random source, so they cannot be guessed or linked to the phone. Written here rather than
/// adding the `uuid` package (S4-D3); tests replace it with a fixed one.
class RandomUuid {
  /// [random] is for tests only; the app always uses `Random.secure()`.
  RandomUuid({Random? random}) : _random = random ?? Random.secure();

  final Random _random;

  /// A new lower-case version-4 UUID, e.g. `6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f`, the shape the
  /// API accepts as a request id.
  String generate() {
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    // Version 4 in the high half of byte 6; the RFC 9562 variant (binary 10) at the top of byte 8.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hexadecimalDigits = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
    return [
      hexadecimalDigits.substring(0, 8),
      hexadecimalDigits.substring(8, 12),
      hexadecimalDigits.substring(12, 16),
      hexadecimalDigits.substring(16, 20),
      hexadecimalDigits.substring(20),
    ].join('-');
  }
}
