/// How a button looks, as the station chose it. The card reader turns an unknown or missing style
/// into [secondary] (reader rule R3), so an older app still draws a sensible button.
enum ActionStyle {
  primary('PRIMARY'),
  secondary('SECONDARY'),
  outline('OUTLINE');

  const ActionStyle(this.wireName);

  /// The value the card carries on the wire, e.g. `PRIMARY`.
  final String wireName;

  /// The style a card asks for, or [secondary] when it names none the app knows.
  static ActionStyle fromWireValue(Object? value) {
    for (final style in values) {
      if (style.wireName == value) return style;
    }
    return secondary;
  }
}

/// One button the Result screen can show, read from the station's card.
///
/// Sealed, so the renderer and the address builder each switch over the four types with no
/// default branch: a fifth type cannot be added without both learning it. Only fields the reader
/// has checked reach here; a type the app does not know never becomes a [UiAction] (rule R1).
sealed class UiAction {
  const UiAction({required this.id, required this.label, required this.style});

  /// The card's id for the action; unique within a card (the reader keeps the first of duplicates).
  final String id;

  /// Exactly as the station wrote it. Never cut here: the screen shortens long labels for display
  /// and gives screen readers the whole text (S4-D20).
  final String label;

  final ActionStyle style;
}

/// Opens the dialler with the number filled in.
final class CallUiAction extends UiAction {
  const CallUiAction({
    required super.id,
    required super.label,
    required super.style,
    required this.phoneNumberE164,
  });

  /// In E.164 form, e.g. `+260977123456`.
  final String phoneNumberE164;
}

/// Opens a WhatsApp chat with the number, optionally with a message already typed.
final class WhatsAppUiAction extends UiAction {
  const WhatsAppUiAction({
    required super.id,
    required super.label,
    required super.style,
    required this.phoneNumberE164,
    this.prefilledText,
  });

  /// In E.164 form, e.g. `+260966123456`.
  final String phoneNumberE164;

  /// The message the chat starts with; null when the card has none or only blank text.
  final String? prefilledText;
}

/// Opens directions to a place.
final class MapUiAction extends UiAction {
  const MapUiAction({
    required super.id,
    required super.label,
    required super.style,
    required this.latitude,
    required this.longitude,
    this.placeName,
  });

  /// Degrees, −90 to 90. May be minus zero, which is in range (the address prints it without a sign).
  final double latitude;

  /// Degrees, −180 to 180.
  final double longitude;

  /// The name the station gave the place; null when the card has none or only blank text.
  final String? placeName;
}

/// Opens a web page in the browser. The only action that carries an address of its own, and the
/// reader keeps it only when it is a canonical https link.
final class LinkUiAction extends UiAction {
  const LinkUiAction({
    required super.id,
    required super.label,
    required super.style,
    required this.link,
  });

  final String link;
}
