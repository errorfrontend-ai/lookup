import 'package:lookup_listener/features/settings/domain/station_list.dart';

/// What the "My station" picker can show of the station list (P6 design §2.12, §3.13). Sealed, so
/// the picker words every case with no default branch.
sealed class StationListReading {
  const StationListReading();
}

/// A list to show: fetched now, kept from an earlier fetch within 24 hours, or kept after a fetch
/// that failed ([isRefreshFailed]: "Couldn't refresh the list. These are the stations saved on …").
final class StationListShown extends StationListReading {
  const StationListShown({
    required this.list,
    required this.fetchedAt,
    this.isRefreshFailed = false,
  });

  /// Exactly what `GET /api/v1/stations` gave, in its order (P6-MYSTATION-02).
  final StationList list;

  /// When the API last gave or confirmed this list, in UTC.
  final DateTime fetchedAt;

  /// Whether a newer list was asked for and could not be had, so this is the one kept on the phone.
  final bool isRefreshFailed;
}

/// No list at all: the fetch failed and none is kept on the phone ("Couldn't load the stations.").
final class StationListUnavailable extends StationListReading {
  const StationListUnavailable();
}
