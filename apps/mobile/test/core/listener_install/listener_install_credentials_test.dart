import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/listener_install/listener_install_credentials.dart';

void main() {
  const installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
  final expiresAt = DateTime.utc(2026, 11, 7, 12);
  final withToken = ListenerInstallCredentials(
    installId: installId,
    installToken: 'token-value',
    tokenExpiresAt: expiresAt,
    registeredAppVersion: '0.1.0+1',
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

  test('withToken keeps the install id, stores the expiry in UTC and the registered version', () {
    const credentials = ListenerInstallCredentials(installId: installId);
    final renewed = credentials.withToken(
      'new',
      DateTime.parse('2026-11-07T14:00:00+02:00'),
      registeredAppVersion: '0.2.0+3',
    );
    expect(renewed.installId, installId);
    expect(renewed.installToken, 'new');
    expect(renewed.tokenExpiresAt, DateTime.utc(2026, 11, 7, 12));
    expect(renewed.tokenExpiresAt!.isUtc, isTrue);
    expect(renewed.registeredAppVersion, '0.2.0+3');
  });

  test('withoutToken keeps the install id and the version it registered with', () {
    final refused = withToken.withoutToken();
    expect(refused.installId, installId);
    expect(refused.installToken, isNull);
    expect(refused.tokenExpiresAt, isNull);
    expect(refused.registeredAppVersion, withToken.registeredAppVersion);
  });

  test('is registered with a version only when it stored exactly that one (contract §1.1)', () {
    expect(withToken.isRegisteredWith('0.1.0+1'), isTrue);
    expect(withToken.isRegisteredWith('0.1.0+2'), isFalse);
    expect(withToken.isRegisteredWith('0.2.0'), isFalse);
    // A Step 4 install never stored one: it counts as another version.
    expect(
      const ListenerInstallCredentials(installId: installId).isRegisteredWith('0.1.0+1'),
      isFalse,
    );
  });
}
