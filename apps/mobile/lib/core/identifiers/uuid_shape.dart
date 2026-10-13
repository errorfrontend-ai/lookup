/// The shape of a UUID as the API writes and accepts one (RFC 9562): lower case, any version from
/// 1 to 8, the RFC variant. Install ids and recognition ids are checked against it before they are
/// trusted.
abstract final class UuidShape {
  static final RegExp _lowerCaseUuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  /// Whether [text] is a lower-case UUID, with nothing before or after it.
  static bool isLowerCaseUuid(String text) => _lowerCaseUuid.hasMatch(text);
}
