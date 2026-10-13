import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/station_list_reading.dart';

/// What the "My station" picker shows of the station list (P6 design §3.6, §3.13): loading while it
/// is first fetched, then the list, the kept list after a failed refresh, or nothing to show.
///
/// Made again each time the picker opens (the provider is dropped when the picker closes), so the
/// 24-hour rule of the repository decides at every open whether to ask the API (P6-MYSTATION-04).
class StationPicker extends AsyncNotifier<StationListReading> {
  @override
  Future<StationListReading> build() => ref.watch(stationListRepositoryProvider).load();

  /// "Try again" after the list could not be loaded: asks once more.
  Future<void> tryAgain() async {
    ref.invalidateSelf();
    await future;
  }
}

/// The picker's list, for as long as the picker is open.
final AsyncNotifierProvider<StationPicker, StationListReading> stationPickerProvider =
    AsyncNotifierProvider.autoDispose<StationPicker, StationListReading>(
      StationPicker.new,
      retry: (retryCount, error) => null,
    );
