import 'package:flutter/material.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/result/presentation/action_button.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';

/// What the registry holds for one action type, [ActionT]: how its button is drawn (the type's
/// icon on an [ActionButton]), how its address is built (the domain's `buildActionUri`), and what
/// the listener can copy when the phone cannot open it.
///
/// Typed by the action it serves, so each builder reads its own action's fields with no cast; the
/// public methods take any [UiAction] and answer nothing for one of another type.
final class ActionRegistration<ActionT extends UiAction> {
  const ActionRegistration({
    required this.icon,
    required String? Function(ActionT action) buildAddress,
    required CopyOffer Function(ActionT action, String address) buildCopyOffer,
  }) : _buildAddress = buildAddress,
       _buildCopyOffer = buildCopyOffer;

  /// Drawn before the label when the screen is wide enough.
  final IconData icon;

  final String? Function(ActionT action) _buildAddress;
  final CopyOffer Function(ActionT action, String address) _buildCopyOffer;

  /// The action type this registration serves.
  Type get actionType => ActionT;

  /// Whether this registration serves [action].
  bool serves(UiAction action) => action is ActionT;

  /// The button for [action]: the station's label and style, with this type's icon when
  /// [showsIcon] is true.
  Widget buildButton(UiAction action, {required bool showsIcon, required VoidCallback onPressed}) {
    return ActionButton(
      label: action.label,
      style: action.style,
      icon: showsIcon ? icon : null,
      onPressed: onPressed,
    );
  }

  /// The address [action]'s button opens, or null when it cannot be opened safely (the button then
  /// opens nothing; S4-LINKS-07) or [action] is not of this type.
  String? buildAddress(UiAction action) => action is ActionT ? _buildAddress(action) : null;

  /// What to offer to copy when the phone could not open [address], or null when [action] is not
  /// of this type.
  CopyOffer? buildCopyOffer(UiAction action, String address) =>
      action is ActionT ? _buildCopyOffer(action, address) : null;
}

/// The renderer's table (design §3.13, S4-RENDERER-02 and -03): exactly one registration for each
/// of the four action types the app knows, and the only place an action type meets a widget.
///
/// An action the card reader skipped never reaches it. An action with no registration (not
/// possible today, as the reader makes only these four) is skipped as well, so an older app shows
/// every action it knows from a newer server (S4-RENDERER-05).
final class ActionRegistry {
  const ActionRegistry(this.registrations);

  /// Call, WhatsApp, map and link: a phone, a speech bubble, a map pin and a globe, as the
  /// wireframes draw them (S4-RESULT-11).
  static const ActionRegistry standard = ActionRegistry([
    ActionRegistration<CallUiAction>(
      icon: Icons.call_outlined,
      buildAddress: buildActionUri,
      buildCopyOffer: _copyCallNumber,
    ),
    ActionRegistration<WhatsAppUiAction>(
      icon: Icons.chat_bubble_outline,
      buildAddress: buildActionUri,
      buildCopyOffer: _copyWhatsAppNumber,
    ),
    ActionRegistration<MapUiAction>(
      icon: Icons.location_on_outlined,
      buildAddress: buildActionUri,
      buildCopyOffer: _copyAddress,
    ),
    ActionRegistration<LinkUiAction>(
      icon: Icons.language,
      buildAddress: buildActionUri,
      buildCopyOffer: _copyAddress,
    ),
  ]);

  final List<ActionRegistration<UiAction>> registrations;

  /// The registration serving [action], or null when there is none.
  ActionRegistration<UiAction>? registrationFor(UiAction action) {
    for (final registration in registrations) {
      if (registration.serves(action)) return registration;
    }
    return null;
  }
}

/// A call button offers its number: the E.164 form is copied, the grouped form shown.
CopyOffer _copyCallNumber(CallUiAction action, String address) =>
    PhoneNumberCopyOffer(phoneNumberE164: action.phoneNumberE164);

/// A WhatsApp button offers its number too, which works in WhatsApp's own search and in the dialler.
CopyOffer _copyWhatsAppNumber(WhatsAppUiAction action, String address) =>
    PhoneNumberCopyOffer(phoneNumberE164: action.phoneNumberE164);

/// Map and link buttons offer the address the app built.
CopyOffer _copyAddress(UiAction action, String address) => LinkCopyOffer(address: address);
