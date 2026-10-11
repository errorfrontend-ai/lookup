import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

const String _storedInstallId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';

ListenerInstallStore _newStore() => ListenerInstallStore(randomUuid: RandomUuid());

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('uses the storage keys the design names', () {
    expect(ListenerInstallStore.installIdKey, 'listener_install_id');
    expect(ListenerInstallStore.installTokenKey, 'listener_install_token');
    expect(ListenerInstallStore.tokenExpiresAtKey, 'listener_install_token_expires_at');
    expect(ListenerInstallStore.registeredAppVersionKey, 'listener_install_registered_app_version');
  });

  test(
    'first launch makes and stores a version-4 install id; later launches read the same one',
    () async {
      expect(await _newStore().read(), isNull);
      final first = await _newStore().readOrCreate();
      expect(first.installId, matches(_versionFourUuid));
      expect(first.installToken, isNull);
      final preferences = await SharedPreferences.getInstance();
      expect(preferences.getString('listener_install_id'), first.installId);

      final secondLaunch = await _newStore().readOrCreate();
      expect(secondLaunch.installId, first.installId);
      expect((await _newStore().read())?.installId, first.installId);
    },
  );

  test('read never makes an install id', () async {
    expect(await _newStore().read(), isNull);
    expect(await _newStore().read(), isNull);
    expect((await SharedPreferences.getInstance()).getKeys(), isEmpty);
  });

  test(
    'a registration is stored and read back: the token, its expiry in UTC, the version',
    () async {
      final store = _newStore();
      final installId = (await store.readOrCreate()).installId;
      await store.saveRegistration(
        installToken: 'aaa.bbb.ccc',
        expiresAt: DateTime.parse('2026-11-07T14:00:00+02:00'),
        appVersion: '0.1.0+1',
      );
      final read = await _newStore().read();
      expect(read?.installId, installId);
      expect(read?.installToken, 'aaa.bbb.ccc');
      expect(read?.tokenExpiresAt, DateTime.utc(2026, 11, 7, 12));
      expect(read?.tokenExpiresAt?.isUtc, isTrue);
      expect(read?.registeredAppVersion, '0.1.0+1');
      expect(
        (await SharedPreferences.getInstance()).getString('listener_install_token_expires_at'),
        '2026-11-07T12:00:00.000Z',
      );
    },
  );

  test('an install a Step 4 app registered has no version stored', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
    });
    final read = await _newStore().read();
    expect(read?.installToken, 'aaa.bbb.ccc');
    expect(read?.registeredAppVersion, isNull);
  });

  test('two engines: a token one stores is the token the other reads next (P6-D45)', () async {
    // Each engine has its own cached SharedPreferences over the same stored values.
    SharedPreferences.setMockInitialValues({'listener_install_id': _storedInstallId});
    final foregroundPreferences = await SharedPreferences.getInstance();
    SharedPreferences.resetStatic();
    final backgroundPreferences = await SharedPreferences.getInstance();
    expect(backgroundPreferences, isNot(same(foregroundPreferences)));
    final foreground = ListenerInstallStore(
      randomUuid: RandomUuid(),
      openPreferences: () async => foregroundPreferences,
    );
    final background = ListenerInstallStore(
      randomUuid: RandomUuid(),
      openPreferences: () async => backgroundPreferences,
    );
    expect((await foreground.read())?.installToken, isNull);

    await background.saveRegistration(
      installToken: 'from.the.background',
      expiresAt: DateTime.utc(2026, 11, 7, 12),
      appVersion: '0.1.0+1',
    );
    // Without a reload the foreground's cache would still hold no token.
    expect(foregroundPreferences.getString('listener_install_token'), isNull);

    final read = await foreground.read();
    expect(read?.installToken, 'from.the.background');
    expect(read?.registeredAppVersion, '0.1.0+1');
  });

  test('forgetting the refused token keeps the install id', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
    });
    expect(await _newStore().forgetToken('aaa.bbb.ccc'), isTrue);
    final read = await _newStore().read();
    expect(read?.installId, _storedInstallId);
    expect(read?.installToken, isNull);
    expect((await SharedPreferences.getInstance()).getKeys(), {'listener_install_id'});

    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
      'listener_install_registered_app_version': '0.1.0+1',
    });
    expect(await _newStore().forgetToken('aaa.bbb.ccc'), isTrue);
    expect((await _newStore().read())?.registeredAppVersion, '0.1.0+1');
  });

  test('two engines: a token the other engine stored after the refusal is kept (P6-D45)', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'refused.token.value',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
    });
    final foregroundPreferences = await SharedPreferences.getInstance();
    SharedPreferences.resetStatic();
    final backgroundPreferences = await SharedPreferences.getInstance();
    final foreground = ListenerInstallStore(
      randomUuid: RandomUuid(),
      openPreferences: () async => foregroundPreferences,
    );
    final background = ListenerInstallStore(
      randomUuid: RandomUuid(),
      openPreferences: () async => backgroundPreferences,
    );
    expect((await foreground.read())?.installToken, 'refused.token.value');
    await background.saveRegistration(
      installToken: 'from.the.background',
      expiresAt: DateTime.utc(2026, 11, 8, 12),
      appVersion: '0.1.0+1',
    );

    expect(await foreground.forgetToken('refused.token.value'), isFalse);
    final read = await foreground.read();
    expect(read?.installToken, 'from.the.background');
    expect(read?.tokenExpiresAt, DateTime.utc(2026, 11, 8, 12));
  });

  test('a token without a readable expiry is treated as no token', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': 'next month',
    });
    final read = await _newStore().read();
    expect(read?.installToken, isNull);
    expect(read?.tokenExpiresAt, isNull);
  });

  test(
    'a stored install id the API would refuse is replaced, with its token and version',
    () async {
      SharedPreferences.setMockInitialValues({
        'listener_install_id': 'not-a-uuid',
        'listener_install_token': 'aaa.bbb.ccc',
        'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
        'listener_install_registered_app_version': '0.1.0+1',
      });
      expect(await _newStore().read(), isNull);
      final created = await _newStore().readOrCreate();
      expect(created.installId, matches(_versionFourUuid));
      expect(created.installToken, isNull);
      final preferences = await SharedPreferences.getInstance();
      expect(preferences.getString('listener_install_id'), created.installId);
      expect(preferences.getString('listener_install_token'), isNull);
      expect(preferences.getString('listener_install_registered_app_version'), isNull);
    },
  );

  test('a readable install id is never replaced', () async {
    SharedPreferences.setMockInitialValues({'listener_install_id': _storedInstallId});
    expect((await _newStore().readOrCreate()).installId, _storedInstallId);
  });

  test('a storage failure is thrown to the caller (the repository decides)', () async {
    final store = ListenerInstallStore(
      randomUuid: RandomUuid(),
      openPreferences: () async => throw StateError('storage is broken'),
    );
    await expectLater(store.readOrCreate(), throwsStateError);
  });
}
