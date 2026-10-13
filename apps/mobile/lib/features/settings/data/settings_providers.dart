import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';

/// Where "My station" is kept (P6 design §3.13): read by the recognition flow at capture for the
/// hint (T1′), written by "Remember my station" (T44). Tests override it, or give
/// `shared_preferences` its mock values. The Home chip and the picker of piece 2 build their
/// `myStationProvider` notifier over this store.
final Provider<MyStationStore> myStationStoreProvider = Provider<MyStationStore>(
  (ref) => MyStationStore(),
  retry: (retryCount, error) => null,
);
