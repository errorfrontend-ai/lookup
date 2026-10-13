import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:shared_preferences/shared_preferences.dart';

const ListenerStation _stationB = ListenerStation(
  id: '0192a6c4-1111-4000-8000-000000000002',
  name: 'Station B',
  frequencyLabel: '104.3 FM',
  city: 'Kitwe',
);

/// "My station" in `shared_preferences` (P6 design §3.13): set, read, and cleared only by the
/// picker's "No station".
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('none is set at first', () async {
    expect(await MyStationStore().read(), isNull);
  });

  test('a remembered station is read back, under my_station, as the design writes it', () async {
    await MyStationStore().remember(_stationB);
    expect(await MyStationStore().read(), _stationB);
    final preferences = await SharedPreferences.getInstance();
    expect(jsonDecode(preferences.getString('my_station')!), {
      'id': '0192a6c4-1111-4000-8000-000000000002',
      'name': 'Station B',
      'frequency_label': '104.3 FM',
      'city': 'Kitwe',
    });
  });

  test('a station with no city is kept with none', () async {
    const noCity = ListenerStation(
      id: '0192a6c4-1111-4000-8000-000000000004',
      name: 'Station D',
      frequencyLabel: '91.3 FM',
    );
    await MyStationStore().remember(noCity);
    expect(await MyStationStore().read(), noCity);
  });

  test('remembering another station replaces it', () async {
    await MyStationStore().remember(_stationB);
    const stationA = ListenerStation(
      id: '0192a6c4-1111-4000-8000-000000000001',
      name: 'Station A',
      frequencyLabel: '98.1 FM',
      city: 'Lusaka',
    );
    await MyStationStore().remember(stationA);
    expect(await MyStationStore().read(), stationA);
  });

  test('"No station" clears it: none is read back, and the key is gone', () async {
    await MyStationStore().remember(_stationB);
    await MyStationStore().clear();
    expect(await MyStationStore().read(), isNull);
    final preferences = await SharedPreferences.getInstance();
    expect(preferences.containsKey('my_station'), isFalse);
  });

  test('clearing when none is set changes nothing', () async {
    await MyStationStore().clear();
    expect(await MyStationStore().read(), isNull);
  });

  test('a logo is never kept with My station', () async {
    await MyStationStore().remember(
      const ListenerStation(
        id: '0192a6c4-1111-4000-8000-000000000002',
        name: 'Station B',
        frequencyLabel: '104.3 FM',
        city: 'Kitwe',
        logo: PublicImage(
          address: 'https://example.com/logo.png',
          widthPixels: 96,
          heightPixels: 96,
          sizeBytes: 2048,
        ),
      ),
    );
    final preferences = await SharedPreferences.getInstance();
    expect(jsonDecode(preferences.getString('my_station')!), isNot(contains('logo')));
    expect(await MyStationStore().read(), _stationB);
  });

  test('a stored value that is not a station reads as none, so no bad hint is ever sent', () async {
    for (final stored in [
      'not json',
      '[]',
      '{"name":"Station B","frequency_label":"104.3 FM"}',
      '{"id":"Station B","name":"Station B","frequency_label":"104.3 FM"}',
      '{"id":"0192a6c4-1111-4000-8000-000000000002","name":" ","frequency_label":"104.3 FM"}',
      '{"id":"0192a6c4-1111-4000-8000-000000000002","name":"Station B"}',
    ]) {
      SharedPreferences.setMockInitialValues({MyStationStore.myStationKey: stored});
      expect(await MyStationStore().read(), isNull, reason: stored);
    }
  });
}
