import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart' show DioExceptionType;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/listener_install/listener_install_registration.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/listener_install/listener_install_store.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/features/settings/data/station_list_cache.dart';
import 'package:lookup_listener/features/settings/data/station_list_repository.dart';
import 'package:lookup_listener/features/settings/domain/station_list_reading.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/fake_clock.dart';
import '../../../support/fake_http_client_adapter.dart';
import '../../../support/recording_client_error_reporter.dart';

const String _storedToken = 'stored.install.token';
const String _entityTag = '"stations-1"';

/// The station list for the "My station" picker (contract §1.4; P6 design §3.13): kept on the phone
/// for 24 hours, asked for again with `If-None-Match` after that, and every error keeps the list the
/// phone has (P6-MYSTATION-02, -04).
void main() {
  late Directory folder;
  late FakeClock clock;
  late FakeHttpClientAdapter adapter;
  late RecordingClientErrorReporter reporter;
  late StationListRepository repository;

  Object? twoStations() =>
      (ContractFixtures.readFile('recognition/listener-station-list/valid/two-stations.json')!
          as Map<String, Object?>)['response'];

  setUp(() {
    folder = Directory.systemTemp.createTempSync('station_list_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    clock = FakeClock(startsAt: DateTime.utc(2026, 10, 13, 7, 12));
    adapter = FakeHttpClientAdapter();
    reporter = RecordingClientErrorReporter();
    SharedPreferences.setMockInitialValues({
      'listener_install_id': '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      'listener_install_token': _storedToken,
      'listener_install_token_expires_at': '2026-11-12T07:12:00.000Z',
      'listener_install_registered_app_version': AppVersion.current,
    });
    final randomUuid = RandomUuid();
    final apiClient = ApiClient(
      configuration: ExampleAppConfigurations.production(),
      randomUuid: randomUuid,
      clock: clock,
      httpClientAdapter: adapter,
    );
    repository = StationListRepository(
      apiClient: apiClient,
      listenerInstallRepository: ListenerInstallRepository(
        store: ListenerInstallStore(randomUuid: randomUuid),
        registration: ListenerInstallRegistration(apiClient: apiClient),
        randomUuid: randomUuid,
        clock: clock,
      ),
      cache: StationListCache(locateFolder: () async => folder),
      clientErrorReporter: reporter,
      clock: clock,
    );
  });

  void answerWithTheList({String entityTag = _entityTag}) => adapter.answerJson(
    200,
    twoStations(),
    headers: {
      'etag': [entityTag],
      'cache-control': ['private, max-age=86400'],
    },
  );

  void answerNotChanged() => adapter.answerText(
    304,
    '',
    headers: {
      'etag': [_entityTag],
    },
  );

  List<FakeHttpRequest> stationRequests() => [
    for (final request in adapter.requests)
      if (request.address.path == '/api/v1/stations') request,
  ];

  List<String> namesOf(StationListReading reading) => [
    for (final station in (reading as StationListShown).list.stations) station.name,
  ];

  group('the first open', () {
    test('asks GET /stations with the install token, and shows exactly what came back', () async {
      answerWithTheList();
      final reading = await repository.load();

      expect(namesOf(reading), ['Station A', 'Station B']);
      expect((reading as StationListShown).isRefreshFailed, isFalse);
      expect(reading.fetchedAt, clock.now());
      final request = stationRequests().single;
      expect(request.method, 'GET');
      expect(request.header('Authorization'), 'Bearer $_storedToken');
      expect(request.hasHeader('If-None-Match'), isFalse, reason: 'nothing kept yet');
      expect(request.bodyBytes, isEmpty);
    });

    test('keeps the list app-private, with its fetch time and entity tag', () async {
      answerWithTheList();
      await repository.load();

      final kept =
          jsonDecode(File('${folder.path}/station-list.json').readAsStringSync())
              as Map<String, Object?>;
      expect(kept['format_version'], 1);
      expect(kept['fetched_at'], '2026-10-13T07:12:00.000Z');
      expect(kept['entity_tag'], _entityTag);
      expect(kept['stations'], (twoStations()! as Map<String, Object?>)['stations']);
    });
  });

  group('kept for 24 hours (P6-MYSTATION-04)', () {
    test('a second open within 24 hours makes no request', () async {
      answerWithTheList();
      await repository.load();
      clock.advance(const Duration(hours: 23, minutes: 59));

      final reading = await repository.load();
      expect(namesOf(reading), ['Station A', 'Station B']);
      expect(stationRequests(), hasLength(1));
    });

    test('after 24 hours the list is fetched again, sending the kept entity tag', () async {
      answerWithTheList();
      await repository.load();
      clock.advance(const Duration(hours: 24));
      answerWithTheList();

      await repository.load();
      expect(stationRequests(), hasLength(2));
      expect(stationRequests().last.header('If-None-Match'), _entityTag);
    });

    test('a 304 keeps the list and starts its 24 hours again', () async {
      answerWithTheList();
      await repository.load();
      clock.advance(const Duration(hours: 25));
      answerNotChanged();

      final reading = await repository.load();
      expect(namesOf(reading), ['Station A', 'Station B']);
      expect((reading as StationListShown).fetchedAt, clock.now());
      expect(reading.isRefreshFailed, isFalse);

      clock.advance(const Duration(hours: 23));
      await repository.load();
      expect(stationRequests(), hasLength(2), reason: 'the 304 reset the 24 hours');
    });

    test('a fetch time more than an hour ahead of the clock (moved back) counts as old', () async {
      answerWithTheList();
      await repository.load();
      clock.setWallClock(clock.now().subtract(const Duration(hours: 2)));
      answerNotChanged();

      await repository.load();
      expect(stationRequests(), hasLength(2));
    });

    test('a fetch time up to an hour ahead still counts as fresh', () async {
      answerWithTheList();
      await repository.load();
      clock.setWallClock(clock.now().subtract(const Duration(minutes: 59)));

      await repository.load();
      expect(stationRequests(), hasLength(1));
    });
  });

  group('every error keeps the kept list', () {
    Future<void> keepAListThenAge() async {
      answerWithTheList();
      await repository.load();
      clock.advance(const Duration(hours: 25));
    }

    final failures = <String, void Function(FakeHttpClientAdapter adapter)>{
      '426': (adapter) => adapter.answerJson(426, {
        'error': {'code': 'APP_UPDATE_REQUIRED', 'message': 'Please update the app.'},
      }),
      '429': (adapter) => adapter.answerJson(
        429,
        {
          'error': {'code': 'RATE_LIMITED', 'message': 'Too many requests.'},
        },
        headers: {
          'retry-after': ['60'],
        },
      ),
      '500': (adapter) => adapter.answerJson(500, {
        'error': {'code': 'INTERNAL', 'message': 'Something went wrong.'},
      }),
      '503': (adapter) => adapter.answerText(503, '<html>busy</html>'),
      'no answer': (adapter) => adapter.failWithDioType(DioExceptionType.connectionError),
      'a timeout': (adapter) => adapter.failWithDioType(DioExceptionType.receiveTimeout),
    };

    for (final MapEntry(key: name, value: fail) in failures.entries) {
      test('$name: the kept list, marked as not refreshed, from its own fetch time', () async {
        await keepAListThenAge();
        final firstFetch = clock.now().subtract(const Duration(hours: 25));
        fail(adapter);

        final reading = await repository.load();
        expect(namesOf(reading), ['Station A', 'Station B']);
        expect((reading as StationListShown).isRefreshFailed, isTrue);
        expect(reading.fetchedAt, firstFetch);
        expect(reporter.reports, isEmpty, reason: 'nothing the app could not read');
      });

      test('$name with nothing kept: no list to show', () async {
        fail(adapter);
        expect(await repository.load(), isA<StationListUnavailable>());
        expect(File('${folder.path}/station-list.json').existsSync(), isFalse);
      });
    }

    test('401: one registration with the same install, then the list', () async {
      adapter.answerJson(401, {
        'error': {'code': 'INSTALL_TOKEN_INVALID', 'message': 'Token refused.'},
      });
      adapter.answerJson(200, {
        'install_token': 'fresh.install.token',
        'expires_at': '2026-11-12T07:12:00.000Z',
      });
      answerWithTheList();

      final reading = await repository.load();
      expect(namesOf(reading), ['Station A', 'Station B']);
      final paths = [for (final request in adapter.requests) request.address.path];
      expect(paths, ['/api/v1/stations', '/api/v1/installs', '/api/v1/stations']);
      expect(stationRequests().last.header('Authorization'), 'Bearer fresh.install.token');
    });

    test('401 after that one registration: the kept list, and no third request', () async {
      await keepAListThenAge();
      for (var index = 0; index < 2; index++) {
        adapter.answerJson(401, {
          'error': {'code': 'INSTALL_TOKEN_INVALID', 'message': 'Token refused.'},
        });
        if (index == 0) {
          adapter.answerJson(200, {
            'install_token': 'fresh.install.token',
            'expires_at': '2026-11-12T07:12:00.000Z',
          });
        }
      }

      final reading = await repository.load();
      expect((reading as StationListShown).isRefreshFailed, isTrue);
      expect(stationRequests(), hasLength(3), reason: 'the first fetch, then two after aging');
      expect(adapter.unusedAnswerCount, 0);
    });

    test('a 200 the rules refuse: the kept list, and a report naming the rule only', () async {
      await keepAListThenAge();
      final refused =
          (ContractFixtures.readFile(
                'recognition/listener-station-list/invalid/station-status-included.json',
              )!
              as Map<String, Object?>)['response'];
      adapter.answerJson(200, refused);

      final reading = await repository.load();
      expect((reading as StationListShown).isRefreshFailed, isTrue);
      final report = reporter.reports.single;
      expect(
        report.error,
        'GET stations answered 200 with a list that breaks the ListenerStationList rules',
      );
      expect('${report.error}', isNot(contains('Station A')));
    });

    test('a 304 with nothing kept is no list, never an empty one', () async {
      answerNotChanged();
      expect(await repository.load(), isA<StationListUnavailable>());
    });
  });

  test('an empty list is a list: shown, and kept for 24 hours like any other', () async {
    adapter.answerJson(200, {'stations': <Object?>[]});
    final reading = await repository.load();
    expect((reading as StationListShown).list.stations, isEmpty);
    await repository.load();
    expect(stationRequests(), hasLength(1));
  });

  test('a kept file this version cannot read is deleted, and the list fetched again', () async {
    folder.createSync(recursive: true);
    File('${folder.path}/station-list.json').writeAsStringSync('{"format_version": 1');
    answerWithTheList();

    final reading = await repository.load();
    expect(namesOf(reading), ['Station A', 'Station B']);
    expect(stationRequests(), hasLength(1));
  });
}
