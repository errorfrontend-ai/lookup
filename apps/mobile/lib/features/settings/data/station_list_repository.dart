import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/settings/data/station_list_cache.dart';
import 'package:lookup_listener/features/settings/domain/station_list.dart';
import 'package:lookup_listener/features/settings/domain/station_list_reading.dart';

/// The stations the "My station" picker lists (contract §1.4; P6 design §3.13): `GET
/// /api/v1/stations`, kept on the phone for 24 hours.
///
/// - A list fetched or confirmed less than [keptFor] ago is shown with no request at all
///   (P6-MYSTATION-04). A fetch time more than [furthestFutureFetchTime] ahead of the phone's clock
///   (the clock was moved back) counts as old, so a wrong clock can never keep a list for good.
/// - Otherwise it asks, with the install token and the kept list's entity tag as `If-None-Match`.
///   A 200 is read by the contract's `ListenerStationList` rules and kept with its `ETag`; a 304
///   keeps the list and starts its 24 hours again.
/// - A 401 registers the install again once, with the same install id, and asks once more.
/// - **Every error keeps the kept list** (401 after that one registration, 426, 429, 5xx, no
///   answer, a list the rules refuse): it is shown with "Couldn't refresh the list", or, with none
///   kept, the picker says it could not load the stations and offers "Try again".
/// - A 200 the rules refuse is the server's fault, so it is reported, by its rule only: never the
///   answer itself.
/// - It is never an outbox item: the list is asked for only while the picker is open.
///
/// Never throws.
final class StationListRepository {
  /// [clock] is for tests; the app uses the real one.
  StationListRepository({
    required ApiClient apiClient,
    required ListenerInstallRepository listenerInstallRepository,
    required StationListCache cache,
    required ClientErrorReporter clientErrorReporter,
    Clock? clock,
  }) : _apiClient = apiClient,
       _listenerInstallRepository = listenerInstallRepository,
       _cache = cache,
       _clientErrorReporter = clientErrorReporter,
       _clock = clock ?? Clock();

  /// How long a fetched list is shown with no new request.
  static const Duration keptFor = Duration(hours: 24);

  /// A fetch time further ahead of the phone's clock than this counts as old.
  static const Duration furthestFutureFetchTime = Duration(hours: 1);

  final ApiClient _apiClient;
  final ListenerInstallRepository _listenerInstallRepository;
  final StationListCache _cache;
  final ClientErrorReporter _clientErrorReporter;
  final Clock _clock;

  /// Whether a list fetched at [fetchedAt] may still be shown at [now] with no request.
  static bool isFresh(DateTime fetchedAt, {required DateTime now}) {
    final age = now.difference(fetchedAt);
    return age < keptFor && -age <= furthestFutureFetchTime;
  }

  /// The list to show: the kept one while it is fresh, otherwise a fetched one, or the kept one
  /// again when the fetch fails.
  Future<StationListReading> load() async {
    final cached = await _readCacheQuietly();
    if (cached != null && isFresh(cached.fetchedAt, now: _clock.now())) {
      return StationListShown(list: cached.list, fetchedAt: cached.fetchedAt);
    }
    final fetched = await _fetch(entityTag: cached?.entityTag);
    final fetchedAt = _clock.now().toUtc();
    switch (fetched) {
      case _ListFetched(:final list, :final stations, :final entityTag):
        await _writeCacheQuietly(stations: stations, fetchedAt: fetchedAt, entityTag: entityTag);
        return StationListShown(list: list, fetchedAt: fetchedAt);
      case _ListNotChanged(:final entityTag) when cached != null:
        await _writeCacheQuietly(
          stations: cached.stations,
          fetchedAt: fetchedAt,
          entityTag: entityTag ?? cached.entityTag,
        );
        return StationListShown(list: cached.list, fetchedAt: fetchedAt);
      case _ListNotChanged() || _ListNotFetched():
        if (cached == null) return const StationListUnavailable();
        return StationListShown(
          list: cached.list,
          fetchedAt: cached.fetchedAt,
          isRefreshFailed: true,
        );
    }
  }

  Future<_FetchOutcome> _fetch({required String? entityTag}) async {
    var registration = await _listenerInstallRepository.ensureRegistered();
    if (registration is! ListenerInstallRegistered) return const _ListNotFetched();
    var answer = await _apiClient.getJson(
      ListenerRoute.stations,
      installToken: registration.installToken,
      ifNoneMatch: entityTag,
    );
    if (answer case ApiAnswerReceived(status: 401)) {
      // The API refused the token: register again once, with the same install id, and ask again.
      registration = await _listenerInstallRepository.registerAgainAfterRefusal(
        refusedToken: registration.installToken,
      );
      if (registration is! ListenerInstallRegistered) return const _ListNotFetched();
      answer = await _apiClient.getJson(
        ListenerRoute.stations,
        installToken: registration.installToken,
        ifNoneMatch: entityTag,
      );
    }
    switch (answer) {
      case ApiAnswerReceived(status: 304, :final entityTag):
        return _ListNotChanged(entityTag: entityTag);
      case ApiAnswerReceived(status: 200, :final body, :final entityTag):
        final value = switch (body) {
          JsonAnswerBody(:final value) => value,
          NotJsonAnswerBody() => null,
        };
        final list = StationList.read(value);
        if (list == null) {
          _reportQuietly(
            'GET stations answered 200 with a list that breaks the ListenerStationList rules',
            relatedRequestId: answer.echoedRequestId ?? answer.sentRequestId,
          );
          return const _ListNotFetched();
        }
        return _ListFetched(
          list: list,
          stations: (value! as Map<Object?, Object?>)['stations'],
          entityTag: entityTag,
        );
      case ApiAnswerReceived() || ApiAnswerNotReceived():
        return const _ListNotFetched();
    }
  }

  Future<CachedStationList?> _readCacheQuietly() async {
    try {
      return await _cache.read();
    } on Object catch (error, stackTrace) {
      _reportQuietly(error, stackTrace: stackTrace, description: 'Reading the station list failed');
      return null;
    }
  }

  Future<void> _writeCacheQuietly({
    required Object? stations,
    required DateTime fetchedAt,
    required String? entityTag,
  }) async {
    try {
      await _cache.write(stations: stations, fetchedAt: fetchedAt, entityTag: entityTag);
    } on Object catch (error, stackTrace) {
      // The list is shown all the same; the next open asks again.
      _reportQuietly(error, stackTrace: stackTrace, description: 'Keeping the station list failed');
    }
  }

  void _reportQuietly(
    Object error, {
    StackTrace? stackTrace,
    String? description,
    String? relatedRequestId,
  }) {
    unawaited(
      _clientErrorReporter
          .report(
            kind: ClientErrorKind.reported,
            error: error,
            stackTrace: stackTrace,
            description: description,
            relatedRequestId: relatedRequestId,
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }
}

/// What one fetch came to.
sealed class _FetchOutcome {
  const _FetchOutcome();
}

/// 200 with a list the rules accept.
final class _ListFetched extends _FetchOutcome {
  const _ListFetched({required this.list, required this.stations, required this.entityTag});

  final StationList list;
  final Object? stations;
  final String? entityTag;
}

/// 304: the kept list still holds.
final class _ListNotChanged extends _FetchOutcome {
  const _ListNotChanged({required this.entityTag});

  final String? entityTag;
}

/// Anything else: no list came.
final class _ListNotFetched extends _FetchOutcome {
  const _ListNotFetched();
}
