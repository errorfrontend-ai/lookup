import 'package:lookup_listener/features/result/domain/canonical_https_link.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

/// The newest card schema this app can read.
const int actionCardSchemaVersion = 1;

/// A card never shows more buttons than this; the rest are dropped (rule R6).
const int maximumActionsPerCard = 6;

/// Buttons beyond this many go under "More options" (rule R6, S4-D18).
const int actionsShownBeforeMoreOptions = 4;

final RegExp _phoneNumberE164 = RegExp(r'^\+[1-9][0-9]{6,14}$');

/// The characters JavaScript's `String.prototype.trim` removes: its white space and line terminators.
/// Written out because Dart's `trim()` also removes U+0085 (next line), which JavaScript keeps, and a
/// label of only U+0085 must be shown here as it is in the portal's preview.
const Set<int> _javaScriptWhitespace = {
  0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680, //
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, //
  0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
};

/// Reads a station's card the way the shared TypeScript reader (`action-card-reader.ts`) does, rule
/// for rule, so the app shows exactly the buttons the portal's preview shows for the same card:
///
///  * R1 an action of a type other than call, WhatsApp, map and link is skipped and counted as
///    unknown; one whose type is not text at all is invalid;
///  * R2 unknown fields are ignored (an extra `url` on a call action is never read);
///  * R3 an unknown or missing style reads as secondary;
///  * R4 any layout reads as a vertical stack;
///  * R5 an action is skipped when its id or label is missing or blank, its phone number is not
///    E.164, its link is not a canonical https link, or its coordinates are out of range; a blank
///    prefilled text or place name is dropped and the action kept;
///  * R6 the first of duplicate ids is kept, at most six are shown, and those after the fourth go
///    under "More options";
///  * R7 a schema version that is not a whole number, or is newer than [supportedSchemaVersion],
///    gives no actions and the update hint;
///  * R8 when nothing can be shown and at least one action was of an unknown type, the update hint
///    shows (actions skipped only for being invalid never show it);
///  * R9 it never throws: anything that is not a card reads as a card with no actions.
///
/// [card] is the decoded JSON, as `jsonDecode` gives it.
ReadActionCard readActionCard(
  Object? card, {
  int supportedSchemaVersion = actionCardSchemaVersion,
}) {
  if (card is! Map<Object?, Object?>) return const ReadActionCard.empty(showsUpdateAppHint: false);
  final schemaVersion = card['schema_version'];
  if (schemaVersion is! num ||
      !_isWholeNumber(schemaVersion) ||
      schemaVersion > supportedSchemaVersion) {
    return const ReadActionCard.empty(showsUpdateAppHint: true);
  }
  final rawActions = card['actions'];

  final readableActions = <UiAction>[];
  final seenActionIds = <String>{};
  var skippedUnknownTypeCount = 0;
  var skippedInvalidCount = 0;
  for (final rawAction in rawActions is List<Object?> ? rawActions : const <Object?>[]) {
    switch (_readAction(rawAction)) {
      case _UnknownType():
        skippedUnknownTypeCount++;
      case _Invalid():
        skippedInvalidCount++;
      case _Readable(:final action):
        if (seenActionIds.add(action.id)) readableActions.add(action);
    }
  }
  final shownActions = readableActions.take(maximumActionsPerCard).toList();
  return ReadActionCard(
    visibleActions: List.unmodifiable(shownActions.take(actionsShownBeforeMoreOptions)),
    moreOptionsActions: List.unmodifiable(shownActions.skip(actionsShownBeforeMoreOptions)),
    skippedUnknownTypeCount: skippedUnknownTypeCount,
    skippedInvalidCount: skippedInvalidCount,
    showsUpdateAppHint: shownActions.isEmpty && skippedUnknownTypeCount > 0,
  );
}

/// What one entry of the card's `actions` list turned out to be.
sealed class _ActionReading {
  const _ActionReading();
}

final class _UnknownType extends _ActionReading {
  const _UnknownType();
}

final class _Invalid extends _ActionReading {
  const _Invalid();
}

final class _Readable extends _ActionReading {
  const _Readable(this.action);

  final UiAction action;
}

const Set<String> _knownActionTypes = {'LINK', 'CALL', 'WHATSAPP', 'MAP'};

_ActionReading _readAction(Object? rawAction) {
  if (rawAction is! Map<Object?, Object?>) return const _Invalid();
  final type = rawAction['type'];
  if (type is! String) return const _Invalid();
  if (!_knownActionTypes.contains(type)) return const _UnknownType();
  final id = rawAction['id'];
  final label = rawAction['label'];
  if (id is! String || !_isNonBlankText(id) || label is! String || !_isNonBlankText(label)) {
    return const _Invalid();
  }
  final style = ActionStyle.fromWireValue(rawAction['style']);

  switch (type) {
    case 'LINK':
      final link = rawAction['url'];
      if (link is! String || !isCanonicalHttpsLink(link)) return const _Invalid();
      return _Readable(LinkUiAction(id: id, label: label, style: style, link: link));
    case 'CALL':
      final phoneNumber = rawAction['phone_number_e164'];
      if (phoneNumber is! String || !_phoneNumberE164.hasMatch(phoneNumber)) {
        return const _Invalid();
      }
      return _Readable(
        CallUiAction(id: id, label: label, style: style, phoneNumberE164: phoneNumber),
      );
    case 'WHATSAPP':
      final phoneNumber = rawAction['phone_number_e164'];
      if (phoneNumber is! String || !_phoneNumberE164.hasMatch(phoneNumber)) {
        return const _Invalid();
      }
      return _Readable(
        WhatsAppUiAction(
          id: id,
          label: label,
          style: style,
          phoneNumberE164: phoneNumber,
          prefilledText: _nonBlankTextOrNull(rawAction['prefilled_text']),
        ),
      );
    default: // MAP, the only known type left.
      final latitude = rawAction['latitude'];
      final longitude = rawAction['longitude'];
      if (latitude is! num || !_isFiniteBetween(latitude, -90, 90)) return const _Invalid();
      if (longitude is! num || !_isFiniteBetween(longitude, -180, 180)) return const _Invalid();
      return _Readable(
        MapUiAction(
          id: id,
          label: label,
          style: style,
          latitude: latitude.toDouble(),
          longitude: longitude.toDouble(),
          placeName: _nonBlankTextOrNull(rawAction['place_name']),
        ),
      );
  }
}

/// JavaScript's `Number.isInteger`: JSON's `1.0` decodes to a Dart double, and must still read as
/// version 1, as it does in JavaScript.
bool _isWholeNumber(num value) =>
    value is int || (value.isFinite && value == value.truncateToDouble());

/// JavaScript's `value.trim().length > 0`: text with at least one character JavaScript does not trim.
bool _isNonBlankText(String text) =>
    text.codeUnits.any((codeUnit) => !_javaScriptWhitespace.contains(codeUnit));

String? _nonBlankTextOrNull(Object? value) =>
    value is String && _isNonBlankText(value) ? value : null;

/// Minus zero is in range, as it is in JavaScript; JSON has no NaN or infinity, but a caller might.
bool _isFiniteBetween(num value, num minimum, num maximum) =>
    value.isFinite && value >= minimum && value <= maximum;
