import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:shared_preferences/shared_preferences.dart';

const ListenerStation _stationA = ListenerStation(
  id: '0192a6c4-1111-4000-8000-000000000001',
  name: 'Station A',
  frequencyLabel: '98.1 FM',
  city: 'Lusaka',
);

String _stored(ListenerStation station) => jsonEncode({
  'id': station.id,
  'name': station.name,
  'frequency_label': station.frequencyLabel,
  'city': station.city,
});

/// "My station" as every screen shows it (P6 design §3.6, §3.13): read from the store, and changed
/// only through it, written first and shown after.
void main() {
  ProviderContainer containerWith(Map<String, Object> preferences) {
    SharedPreferences.setMockInitialValues(preferences);
    final container = ProviderContainer(retry: (retryCount, error) => null);
    addTearDown(container.dispose);
    return container;
  }

  test('reads the stored station, or none', () async {
    expect(
      await containerWith({
        MyStationStore.myStationKey: _stored(_stationA),
      }).read(myStationProvider.future),
      _stationA,
    );
    expect(await containerWith({}).read(myStationProvider.future), isNull);
  });

  test('choosing a station stores it, then shows it; its logo is not kept', () async {
    final container = containerWith({});
    await container.read(myStationProvider.future);
    await container
        .read(myStationProvider.notifier)
        .choose(
          const ListenerStation(
            id: '0192a6c4-1111-4000-8000-000000000001',
            name: 'Station A',
            frequencyLabel: '98.1 FM',
            city: 'Lusaka',
            logo: PublicImage(
              address: 'https://example.com/logo.png',
              widthPixels: 96,
              heightPixels: 96,
              sizeBytes: 2048,
            ),
          ),
        );
    expect(container.read(myStationProvider).value, _stationA);
    expect(await MyStationStore().read(), _stationA);
  });

  test('"No station" clears it in the store and on screen', () async {
    final container = containerWith({MyStationStore.myStationKey: _stored(_stationA)});
    expect(await container.read(myStationProvider.future), _stationA);
    await container.read(myStationProvider.notifier).clear();
    expect(container.read(myStationProvider).value, isNull);
    expect(container.read(myStationProvider).hasValue, isTrue);
    expect(await MyStationStore().read(), isNull);
  });

  test('a choice made before the first read ends is never undone by it', () async {
    final container = containerWith({});
    // No await: the first read is still under way when the choice is made.
    final choice = container.read(myStationProvider.notifier).choose(_stationA);
    await choice;
    await Future<void>.delayed(Duration.zero);
    expect(container.read(myStationProvider).value, _stationA);
  });

  test('a write the phone refuses is thrown, and the shown station stays as it was', () async {
    SharedPreferences.setMockInitialValues({MyStationStore.myStationKey: _stored(_stationA)});
    final container = ProviderContainer(
      overrides: [
        myStationStoreProvider.overrideWithValue(
          MyStationStore(openPreferences: () async => _RefusingPreferences()),
        ),
      ],
      retry: (retryCount, error) => null,
    );
    addTearDown(container.dispose);
    await container.read(myStationProvider.future);
    await expectLater(
      container
          .read(myStationProvider.notifier)
          .choose(
            const ListenerStation(
              id: '0192a6c4-1111-4000-8000-000000000002',
              name: 'Station B',
              frequencyLabel: '104.3 FM',
            ),
          ),
      throwsA(isA<MyStationNotWritten>()),
    );
    expect(container.read(myStationProvider).value, _stationA);
  });
}

/// Preferences that hold Station A and refuse every write.
class _RefusingPreferences implements SharedPreferences {
  @override
  String? getString(String key) => key == MyStationStore.myStationKey ? _stored(_stationA) : null;

  @override
  Future<bool> setString(String key, String value) async => false;

  @override
  Future<bool> remove(String key) async => false;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
