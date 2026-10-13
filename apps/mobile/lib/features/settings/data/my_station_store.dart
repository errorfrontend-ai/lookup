import 'dart:convert';

import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Keeps "My station" in `shared_preferences` under `my_station`, as the JSON object
/// `{id, name, frequency_label, city}` (P6 design §3.13): app-private storage, never backed up.
///
/// - It is written by the foreground engine only ("Remember my station", and the picker from piece
///   2), so it needs no reload between engines (§3.12, P6-D45).
/// - A stored value that is not such an object, or whose id is not a UUID, reads as no station: the
///   app then sends no hint, which is what it did before one was set, and never a value the server
///   would refuse. The broken value is left as it is; the next "Remember" replaces it.
/// - The app never clears it by itself (contract §5.8); the picker's "No station" (piece 2) will.
///
/// A failure to read or write is thrown to the caller, which decides what it means: the recognition
/// flow sends no hint when the read fails and reports a failed write quietly.
class MyStationStore {
  /// [openPreferences] is for tests; the app uses `SharedPreferences.getInstance`.
  MyStationStore({Future<SharedPreferences> Function()? openPreferences})
    : _openPreferences = openPreferences ?? SharedPreferences.getInstance;

  /// The storage key, exactly as the design names it.
  static const String myStationKey = 'my_station';

  /// The ids the contract gives stations: a UUID of version 1 to 8.
  static final RegExp _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  final Future<SharedPreferences> Function() _openPreferences;

  /// "My station", or null when none is set or the stored value cannot be read as one.
  Future<ListenerStation?> read() async {
    final preferences = await _openPreferences();
    final stored = preferences.getString(myStationKey);
    if (stored == null) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(stored);
    } on FormatException {
      return null;
    }
    if (decoded case {
      'id': final String id,
      'name': final String name,
      'frequency_label': final String frequencyLabel,
    } when _uuid.hasMatch(id) && name.trim().isNotEmpty && frequencyLabel.trim().isNotEmpty) {
      final city = decoded['city'];
      return ListenerStation(
        id: id,
        name: name,
        frequencyLabel: frequencyLabel,
        city: city is String && city.trim().isNotEmpty ? city : null,
      );
    }
    return null;
  }

  /// Makes [station] "My station", replacing any other. Its id becomes the hint of every clip
  /// captured from now on (P6-CHOOSER-07).
  Future<void> remember(ListenerStation station) async {
    final preferences = await _openPreferences();
    final isWritten = await preferences.setString(
      myStationKey,
      jsonEncode({
        'id': station.id,
        'name': station.name,
        'frequency_label': station.frequencyLabel,
        'city': station.city,
      }),
    );
    if (!isWritten) throw const MyStationNotWritten();
  }
}

/// The phone's storage refused to keep "My station".
final class MyStationNotWritten implements Exception {
  const MyStationNotWritten();

  @override
  String toString() => 'MyStationNotWritten: the phone did not keep My station';
}
