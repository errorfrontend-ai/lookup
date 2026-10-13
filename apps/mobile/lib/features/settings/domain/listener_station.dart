/// A station as the listener app keeps it for "My station" (P6 design §3.13; contract §2.1's
/// `ListenerStation`, without its logo): its id, which the app sends as the hint, and the words the
/// app shows for it.
///
/// Set by "Remember my station" in the chooser (T44) and, from piece 2, by the picker. The app never
/// clears it by itself, even when a fresh station list no longer has it (contract §5.8).
final class ListenerStation {
  const ListenerStation({
    required this.id,
    required this.name,
    required this.frequencyLabel,
    this.city,
  });

  /// The station's one public reference (S3-RESPONSE-17), a UUID: the hint the app sends.
  final String id;

  /// E.g. "Station B".
  final String name;

  /// E.g. "104.3 FM".
  final String frequencyLabel;

  /// E.g. "Kitwe"; null when the station has none.
  final String? city;

  @override
  bool operator ==(Object other) =>
      other is ListenerStation &&
      other.id == id &&
      other.name == name &&
      other.frequencyLabel == frequencyLabel &&
      other.city == city;

  @override
  int get hashCode => Object.hash(id, name, frequencyLabel, city);

  @override
  String toString() => 'ListenerStation($name, $frequencyLabel)';
}
