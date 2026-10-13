import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/features/settings/domain/station_list.dart';

import '../../../support/contract_fixtures.dart';

/// The station list read by the contract's `ListenerStationList` rules (contract §1.4, §2.6;
/// P6-MYSTATION-02): the shared fixtures, valid lists shown in their order, invalid ones refused.
void main() {
  Object? responseOf(NamedFixture fixture) =>
      (fixture.content! as Map<String, Object?>)['response'];

  group('the shared fixtures', () {
    final valid = ContractFixtures.readFolder('recognition/listener-station-list/valid');
    final invalid = ContractFixtures.readFolder('recognition/listener-station-list/invalid');

    test('there are valid and invalid lists to read', () {
      expect(valid.map((fixture) => fixture.name), containsAll(['two-stations', 'no-stations']));
      expect(invalid, hasLength(greaterThanOrEqualTo(4)));
    });

    for (final fixture in valid) {
      test('valid/${fixture.name} is read, every station in the answer\'s order', () {
        final list = StationList.read(responseOf(fixture));
        expect(list, isNotNull);
        final stations =
            ((responseOf(fixture)! as Map<String, Object?>)['stations']! as List<Object?>)
                .cast<Map<String, Object?>>();
        expect(list!.stations.map((station) => station.id), [
          for (final station in stations) station['id'],
        ]);
      });
    }

    for (final fixture in invalid) {
      test('invalid/${fixture.name} is refused whole', () {
        expect(StationList.read(responseOf(fixture)), isNull);
      });
    }
  });

  test('two-stations reads as Station A on 98.1 FM in Lusaka, then Station B', () {
    final fixture =
        ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
            as Map<String, Object?>;
    final list = StationList.read(fixture['response'])!;
    expect(list.stations, const [
      ListenerStation(
        id: '0192a6c4-1111-4000-8000-000000000001',
        name: 'Station A',
        frequencyLabel: '98.1 FM',
        city: 'Lusaka',
      ),
      ListenerStation(
        id: '0192a6c4-1111-4000-8000-000000000002',
        name: 'Station B',
        frequencyLabel: '104.3 FM',
        city: 'Kitwe',
      ),
    ]);
  });

  group('the rules beyond the fixtures', () {
    Map<String, Object?> station({
      String id = '0192a6c4-1111-4000-8000-000000000001',
      Object? name = 'Station A',
      Object? frequencyLabel = '98.1 FM',
      Object? city = 'Lusaka',
      Object? logo,
    }) => {'id': id, 'name': name, 'frequency_label': frequencyLabel, 'city': city, 'logo': logo};

    test('a logo is kept when it is a public https image with its sizes', () {
      final list = StationList.read({
        'stations': [
          station(
            logo: {
              'address': 'https://example.com/logo.png',
              'width_pixels': 96,
              'height_pixels': 96,
              'size_bytes': 2048,
            },
          ),
        ],
      })!;
      expect(list.stations.single.logo!.address, 'https://example.com/logo.png');
    });

    test('anything outside the rules refuses the whole list', () {
      final tooMany = [
        for (var index = 0; index < StationList.maximumStations + 1; index++)
          station(id: '0192a6c4-1111-4000-8000-${index.toString().padLeft(12, '0')}'),
      ];
      for (final (reason, answer) in <(String, Object?)>[
        ('not an object', <Object?>[]),
        ('another key beside stations', {'stations': <Object?>[], 'count': 0}),
        ('stations not a list', {'stations': 'Station A'}),
        ('more than 1,000 stations', {'stations': tooMany}),
        (
          'an empty name',
          {
            'stations': [station(name: '')],
          },
        ),
        (
          'a name of 121 characters',
          {
            'stations': [station(name: 'A' * 121)],
          },
        ),
        (
          'a frequency of 33 characters',
          {
            'stations': [station(frequencyLabel: '9' * 33)],
          },
        ),
        (
          'an empty city',
          {
            'stations': [station(city: '')],
          },
        ),
        (
          'a city of 81 characters',
          {
            'stations': [station(city: 'L' * 81)],
          },
        ),
        (
          'a city that is not text',
          {
            'stations': [station(city: 7)],
          },
        ),
        (
          'a key left out',
          {
            'stations': [
              {'id': '0192a6c4-1111-4000-8000-000000000001', 'name': 'A', 'frequency_label': '1'},
            ],
          },
        ),
        (
          'a plain http logo',
          {
            'stations': [
              station(
                logo: {
                  'address': 'http://example.com/logo.png',
                  'width_pixels': 96,
                  'height_pixels': 96,
                  'size_bytes': 2048,
                },
              ),
            ],
          },
        ),
        (
          'a logo with no size',
          {
            'stations': [
              station(logo: {'address': 'https://example.com/logo.png'}),
            ],
          },
        ),
      ]) {
        expect(StationList.read(answer), isNull, reason: reason);
      }
      expect(StationList.read({'stations': tooMany.take(1000).toList()}), isNotNull);
    });
  });

  group('the picker\'s search, made on the phone', () {
    final list = StationList([
      for (final (name, frequency, city) in [
        ('Station A', '98.1 FM', 'Lusaka'),
        ('Radio Phoenix', '89.5 FM', 'Lusaka'),
        ('Flava FM', '87.7 FM', 'Kitwe'),
        ('Station D', '95.7 FM', null),
      ])
        ListenerStation(
          id: '0192a6c4-1111-4000-8000-00000000000${name.length % 10}',
          name: name,
          frequencyLabel: frequency,
          city: city,
        ),
    ]);

    List<String> namesMatching(String query) =>
        list.stationsMatching(query).map((station) => station.name).toList();

    test('matches the name, the frequency or the city, ignoring case, in the list\'s order', () {
      expect(namesMatching('phoenix'), ['Radio Phoenix']);
      expect(namesMatching('87.7'), ['Flava FM']);
      expect(namesMatching('LUSAKA'), ['Station A', 'Radio Phoenix']);
      expect(namesMatching('  station '), ['Station A', 'Station D']);
      expect(namesMatching('Ndola'), isEmpty);
    });

    test('an empty search shows every station', () {
      expect(namesMatching(''), hasLength(4));
      expect(namesMatching('   '), hasLength(4));
    });
  });
}
