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

  test('a token and its expiry are stored and read back in UTC', () async {
    final store = _newStore();
    final installId = (await store.readOrCreate()).installId;
    await store.saveToken(
      installToken: 'aaa.bbb.ccc',
      expiresAt: DateTime.parse('2026-11-07T14:00:00+02:00'),
    );
    final read = await _newStore().read();
    expect(read?.installId, installId);
    expect(read?.installToken, 'aaa.bbb.ccc');
    expect(read?.tokenExpiresAt, DateTime.utc(2026, 11, 7, 12));
    expect(read?.tokenExpiresAt?.isUtc, isTrue);
    expect(
      (await SharedPreferences.getInstance()).getString('listener_install_token_expires_at'),
      '2026-11-07T12:00:00.000Z',
    );
  });

  test('forgetting the token keeps the install id', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': _storedInstallId,
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
    });
    await _newStore().forgetToken();
    final read = await _newStore().read();
    expect(read?.installId, _storedInstallId);
    expect(read?.installToken, isNull);
    expect((await SharedPreferences.getInstance()).getKeys(), {'listener_install_id'});
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

  test('a stored install id the API would refuse is replaced, with its token', () async {
    SharedPreferences.setMockInitialValues({
      'listener_install_id': 'not-a-uuid',
      'listener_install_token': 'aaa.bbb.ccc',
      'listener_install_token_expires_at': '2026-11-07T12:00:00.000Z',
    });
    expect(await _newStore().read(), isNull);
    final created = await _newStore().readOrCreate();
    expect(created.installId, matches(_versionFourUuid));
    expect(created.installToken, isNull);
    final preferences = await SharedPreferences.getInstance();
    expect(preferences.getString('listener_install_id'), created.installId);
    expect(preferences.getString('listener_install_token'), isNull);
  });

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
