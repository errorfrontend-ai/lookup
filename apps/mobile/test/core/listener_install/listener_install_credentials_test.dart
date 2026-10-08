import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/listener_install/listener_install_credentials.dart';

void main() {
  const installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
  final expiresAt = DateTime.utc(2026, 11, 7, 12);
  final withToken = ListenerInstallCredentials(
    installId: installId,
    installToken: 'token-value',
    tokenExpiresAt: expiresAt,
  );

  group('needsRegistrationAt', () {
    test('with no token, always', () {
      const noToken = ListenerInstallCredentials(installId: installId);
      expect(noToken.needsRegistrationAt(DateTime.utc(2026, 10, 8)), isTrue);
    });

    test('a token with no expiry counts as no token', () {
      const noExpiry = ListenerInstallCredentials(installId: installId, installToken: 'token');
      expect(noExpiry.needsRegistrationAt(DateTime.utc(2026, 10, 8)), isTrue);
    });

    test('not while the token has more than 24 hours left', () {
      expect(withToken.needsRegistrationAt(DateTime.utc(2026, 10, 8)), isFalse);
      expect(
        withToken.needsRegistrationAt(
          expiresAt.subtract(const Duration(hours: 24, milliseconds: 1)),
        ),
        isFalse,
      );
    });

    test('from 24 hours before the expiry, and after it', () {
      expect(withToken.needsRegistrationAt(expiresAt.subtract(const Duration(hours: 24))), isTrue);
      expect(withToken.needsRegistrationAt(expiresAt.subtract(const Duration(hours: 1))), isTrue);
      expect(withToken.needsRegistrationAt(expiresAt.add(const Duration(days: 3))), isTrue);
    });
  });

  test('hasUnexpiredTokenAt: inside the lifetime only', () {
    expect(withToken.hasUnexpiredTokenAt(expiresAt.subtract(const Duration(hours: 1))), isTrue);
    expect(withToken.hasUnexpiredTokenAt(expiresAt), isFalse);
    expect(
      const ListenerInstallCredentials(installId: installId).hasUnexpiredTokenAt(expiresAt),
      isFalse,
    );
  });

  test('withToken keeps the install id and stores the expiry in UTC', () {
    const credentials = ListenerInstallCredentials(installId: installId);
    final renewed = credentials.withToken('new', DateTime.parse('2026-11-07T14:00:00+02:00'));
    expect(renewed.installId, installId);
    expect(renewed.installToken, 'new');
    expect(renewed.tokenExpiresAt, DateTime.utc(2026, 11, 7, 12));
    expect(renewed.tokenExpiresAt!.isUtc, isTrue);
  });

  test('withoutToken keeps only the install id', () {
    final refused = withToken.withoutToken();
    expect(refused.installId, installId);
    expect(refused.installToken, isNull);
    expect(refused.tokenExpiresAt, isNull);
  });
}
