import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/settings/data/my_station_setting.dart';
import 'package:lookup_listener/features/settings/data/picture_setting_store.dart';
import 'package:lookup_listener/features/settings/data/station_list_repository.dart';
import 'package:lookup_listener/features/settings/domain/data_saver_rule.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';

export 'package:lookup_listener/features/settings/data/my_station_store.dart'
    show myStationStoreProvider;
export 'package:lookup_listener/features/settings/data/picture_setting_store.dart'
    show pictureSettingStoreProvider;

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

/// "Load ad pictures on mobile data" (P6 design §3.16; P6-DATASAVER-04): on by default.
final AsyncNotifierProvider<LoadsPicturesOnMobileData, bool> loadsPicturesOnMobileDataProvider =
    AsyncNotifierProvider<LoadsPicturesOnMobileData, bool>(
      LoadsPicturesOnMobileData.new,
      retry: (retryCount, error) => null,
    );

/// Whether the network in use is metered (mobile data, a hotspot) now. `lib/app` gives it from the
/// device plugin through `appServiceOverrides`; without it the network counts as unmetered, so
/// nothing is held back.
final Provider<bool> isNetworkMeteredProvider = Provider<bool>(
  (ref) => false,
  retry: (retryCount, error) => null,
);

/// The bytes counted this month for "Used this month" (P6 design §3.16), and again after each
/// change. `lib/app` gives it from the data-use meter through `appServiceOverrides`.
final StreamProvider<int> bytesUsedThisMonthProvider = StreamProvider<int>(
  (ref) => Stream<int>.value(0),
  retry: (retryCount, error) => null,
);

/// Whether a result may load its pictures now (P6-DATASAVER-05, -06): decided from what is known
/// before the result's first frame. Until the switch has been read, a metered network loads none.
final Provider<bool> mayLoadPicturesProvider = Provider<bool>(
  (ref) => DataSaverRule.mayLoadPictures(
    isSwitchOn: ref.watch(loadsPicturesOnMobileDataProvider).value ?? false,
    isNetworkMetered: ref.watch(isNetworkMeteredProvider),
  ),
  retry: (retryCount, error) => null,
);
