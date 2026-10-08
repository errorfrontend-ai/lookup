/// What the phone knows about its own listener install (design §3.9, S4-D14): the install id it made
/// for itself on first launch, and the install token the API gave it with the token's expiry.
///
/// The install id is a random version-4 UUID, never a hardware, Android, advertising or IMEI id, so
/// it cannot be linked to the phone or the person (S4-INSTALLS-01). It leaves the phone only in the
/// registration body; the token only as a bearer header.
final class ListenerInstallCredentials {
  const ListenerInstallCredentials({
    required this.installId,
    this.installToken,
    this.tokenExpiresAt,
  });

  /// How long before the token's expiry the app registers again, so a token never runs out in the
  /// middle of an identify.
  static const Duration renewalMargin = Duration(hours: 24);

  /// The install's own id, made once with `RandomUuid` and kept for good.
  final String installId;

  /// The token for `Authorization: Bearer` on the listener routes; null before the first
  /// registration or after the API refused it.
  final String? installToken;

  /// When the API said the token stops working, in UTC; null when there is no token.
  final DateTime? tokenExpiresAt;

  /// Whether the app must register before using the token, judged by the phone's clock at [now]:
  /// no token, or within [renewalMargin] of its expiry (or past it). The phone's clock can be
  /// wrong, so this only saves a wasted request; a 401 from the API is the real signal.
  bool needsRegistrationAt(DateTime now) {
    final expiresAt = tokenExpiresAt;
    if (installToken == null || expiresAt == null) return true;
    return !now.isBefore(expiresAt.subtract(renewalMargin));
  }

  /// Whether the token is still inside its lifetime at [now] by the phone's clock, even if it is
  /// due for renewal: such a token is still worth using when a renewal fails.
  bool hasUnexpiredTokenAt(DateTime now) {
    final expiresAt = tokenExpiresAt;
    return installToken != null && expiresAt != null && now.isBefore(expiresAt);
  }

  /// The same install with a new token.
  ListenerInstallCredentials withToken(String installToken, DateTime expiresAt) =>
      ListenerInstallCredentials(
        installId: installId,
        installToken: installToken,
        tokenExpiresAt: expiresAt.toUtc(),
      );

  /// The same install with no token, after the API refused it.
  ListenerInstallCredentials withoutToken() => ListenerInstallCredentials(installId: installId);
}
