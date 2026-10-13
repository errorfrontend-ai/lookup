import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// A station as the listener app knows it (P6 design §3.13; contract §2.1's `ListenerStation`): its
/// id, which the app sends as the hint, the words the app shows for it, and its logo when the
/// station list gave one.
///
/// "My station" is one of these, set by "Remember my station" in the chooser (T44) or by the
/// picker, and kept without its logo (`MyStationStore`). The app never clears it by itself, even
/// when a fresh station list no longer has it (contract §5.8).
final class ListenerStation {
  const ListenerStation({
    required this.id,
    required this.name,
    required this.frequencyLabel,
    this.city,
    this.logo,
  });

  /// The station's one public reference (S3-RESPONSE-17), a UUID: the hint the app sends.
  final String id;

  /// E.g. "Station B".
  final String name;

  /// E.g. "104.3 FM".
  final String frequencyLabel;

  /// E.g. "Kitwe"; null when the station has none.
  final String? city;

  /// The station's logo in the station list; null when it has none, and always for "My station",
  /// which is kept without one.
  final PublicImage? logo;

  /// This station as "My station" keeps it: everything but the logo.
  ListenerStation withoutLogo() =>
      ListenerStation(id: id, name: name, frequencyLabel: frequencyLabel, city: city);

  @override
  bool operator ==(Object other) =>
      other is ListenerStation &&
      other.id == id &&
      other.name == name &&
      other.frequencyLabel == frequencyLabel &&
      other.city == city &&
      other.logo?.address == logo?.address;

  @override
  int get hashCode => Object.hash(id, name, frequencyLabel, city, logo?.address);

  @override
  String toString() => 'ListenerStation($name, $frequencyLabel)';
}
