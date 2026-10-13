import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/settings/data/my_station_setting.dart';
import 'package:lookup_listener/features/settings/data/station_list_repository.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';

export 'package:lookup_listener/features/settings/data/my_station_store.dart'
    show myStationStoreProvider;

/// "My station" as every screen shows it (P6 design §3.6, §3.13): Home's chip, the Settings row and
/// the picker watch it, and the picker and "Remember my station" change it through it. Never
/// rebuilt on its own after a failure (S4-D4).
final AsyncNotifierProvider<MyStationSetting, ListenerStation?> myStationProvider =
    AsyncNotifierProvider<MyStationSetting, ListenerStation?>(
      MyStationSetting.new,
      retry: (retryCount, error) => null,
    );

/// The station list the picker shows (P6 design §3.13): `GET /api/v1/stations`, kept for 24 hours.
///
/// It needs the app's API client, install repository, crash reporter, clock and support folder,
/// which `lib/app` provides, so `bootstrap()` gives it through `appServiceOverrides`; tests
/// override it with one over a fake HTTP adapter and a temporary folder. Reading it without that
/// override is a mistake in the app's set-up, not something a listener can cause.
final Provider<StationListRepository> stationListRepositoryProvider =
    Provider<StationListRepository>(
      (ref) => throw UnimplementedError(
        'Override stationListRepositoryProvider at start-up with the app StationListRepository.',
      ),
      retry: (retryCount, error) => null,
    );
