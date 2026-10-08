/// The reference code a listener reads out to support (S4-D9): the first 8 hex digits of the API's
/// request id, upper case, as XXXX-XXXX, e.g. "6f1c2d3e-…" gives "6F1C-2D3E". Support finds the log
/// line by searching for a requestId that starts with those 8 digits in lower case.
///
/// The Dart mirror of `referenceCodeForRequestId` in
/// packages/contracts/src/errors/reference-code.ts, rule for rule; both are tested against
/// packages/contracts/fixtures/errors/reference-codes.json, so the app, the portal and the API never
/// disagree about a code.
abstract final class ReferenceCode {
  /// A request id as the API gives one: a UUID of version 1 to 8, the same rule the API applies to
  /// X-Request-Id.
  static final RegExp _requestIdUuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  /// The code for [requestId], or null for anything that is not a request id the API could have
  /// logged, so no code is ever shown that support cannot find.
  static String? forRequestId(String requestId) {
    if (!_requestIdUuid.hasMatch(requestId)) return null;
    final firstEightDigits = requestId.substring(0, 8).toUpperCase();
    return '${firstEightDigits.substring(0, 4)}-${firstEightDigits.substring(4)}';
  }
}
