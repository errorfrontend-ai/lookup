import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';

/// The stations listed in the app, exactly as `GET /api/v1/stations` gave them and in its order
/// (contract §1.4; P6 design §2.12, §3.13; P6-MYSTATION-02): what the "My station" picker lists.
///
/// [read] holds an answer to the contract's `ListenerStationList` rules and refuses it whole when it
/// breaks any of them, so the picker never shows a list the server did not mean to send: a strict
/// object of `stations` only; at most [maximumStations]; each station a strict object of `id` (a
/// UUID), `name` (1 to 120 characters), `frequency_label` (1 to 32), `city` (null, or 1 to 80) and
/// `logo` (null, or a public `https` image with its sizes), every key present; and no station twice.
final class StationList {
  StationList(List<ListenerStation> stations) : stations = List.unmodifiable(stations);

  /// The most stations one answer may list (`MAXIMUM_LISTED_STATIONS`).
  static const int maximumStations = 1000;

  /// The station list's limits on its words, in characters (contract §2.1).
  static const int longestName = 120;
  static const int longestFrequencyLabel = 32;
  static const int longestCity = 80;

  /// A public image's limits (`PublicImage`).
  static const int longestImageAddress = 2048;
  static const int largestImageSidePixels = 4096;

  /// The stations, in the answer's order, which the app never changes.
  final List<ListenerStation> stations;

  /// The station with [stationId], or null when the list does not have it.
  ListenerStation? stationWithId(String stationId) =>
      stations.where((station) => station.id == stationId).firstOrNull;

  /// The stations whose name, frequency or city holds [query], ignoring case and the spaces
  /// around it, in the list's order: the picker's search, made on the phone (gap 33). An empty
  /// query matches every station.
  List<ListenerStation> stationsMatching(String query) {
    final wanted = query.trim().toLowerCase();
    if (wanted.isEmpty) return stations;
    bool holds(String? text) => text != null && text.toLowerCase().contains(wanted);
    return [
      for (final station in stations)
        if (holds(station.name) || holds(station.frequencyLabel) || holds(station.city)) station,
    ];
  }

  /// [answer] as a station list, or null when it breaks any rule of `ListenerStationList`.
  static StationList? read(Object? answer) {
    if (answer is! Map<Object?, Object?> || !_hasExactlyKeys(answer, const {'stations'})) {
      return null;
    }
    final entries = answer['stations'];
    if (entries is! List<Object?> || entries.length > maximumStations) return null;
    final stations = <ListenerStation>[];
    final seenStationIds = <String>{};
    for (final entry in entries) {
      final station = _readStation(entry);
      if (station == null || !seenStationIds.add(station.id)) return null;
      stations.add(station);
    }
    return StationList(stations);
  }

  static ListenerStation? _readStation(Object? entry) {
    if (entry is! Map<Object?, Object?> || !_hasExactlyKeys(entry, _stationKeys)) return null;
    final id = entry['id'];
    final name = entry['name'];
    final frequencyLabel = entry['frequency_label'];
    final city = entry['city'];
    if (id is! String || !_uuid.hasMatch(id)) return null;
    if (!_isTextOfLength(name, longestName) ||
        !_isTextOfLength(frequencyLabel, longestFrequencyLabel)) {
      return null;
    }
    if (city != null && !_isTextOfLength(city, longestCity)) return null;
    final logoEntry = entry['logo'];
    final logo = logoEntry == null ? null : _readImage(logoEntry);
    if (logoEntry != null && logo == null) return null;
    return ListenerStation(
      id: id,
      name: name! as String,
      frequencyLabel: frequencyLabel! as String,
      city: city as String?,
      logo: logo,
    );
  }

  static PublicImage? _readImage(Object? image) {
    if (image is! Map<Object?, Object?> || !_hasExactlyKeys(image, _imageKeys)) return null;
    final address = image['address'];
    final widthPixels = image['width_pixels'];
    final heightPixels = image['height_pixels'];
    final sizeBytes = image['size_bytes'];
    if (address is! String ||
        address.length > longestImageAddress ||
        !_httpsAddress.hasMatch(address)) {
      return null;
    }
    if (!_isImageSide(widthPixels) || !_isImageSide(heightPixels)) return null;
    if (sizeBytes is! int || sizeBytes < 1) return null;
    return PublicImage(
      address: address,
      widthPixels: widthPixels! as int,
      heightPixels: heightPixels! as int,
      sizeBytes: sizeBytes,
    );
  }

  static bool _hasExactlyKeys(Map<Object?, Object?> object, Set<String> keys) =>
      object.length == keys.length && object.keys.every(keys.contains);

  static bool _isTextOfLength(Object? text, int longest) =>
      text is String && text.isNotEmpty && text.length <= longest;

  static bool _isImageSide(Object? pixels) =>
      pixels is int && pixels >= 1 && pixels <= largestImageSidePixels;

  static const Set<String> _stationKeys = {'id', 'name', 'frequency_label', 'city', 'logo'};
  static const Set<String> _imageKeys = {'address', 'width_pixels', 'height_pixels', 'size_bytes'};

  /// A station id: a UUID of version 1 to 8, as `z.uuid()` and the emitted schema accept it (they
  /// also accept the nil and max UUIDs, which no station is ever given; a list naming one is
  /// refused here, and "My station" could never keep it).
  static final RegExp _uuid = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  );

  /// `PublicImage.address`: https, a host, no white space.
  static final RegExp _httpsAddress = RegExp(r'^https://[^\s/?#]+[^\s]*$');
}
