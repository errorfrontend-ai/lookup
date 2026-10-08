import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

/// The message a support chat starts with: the listener only has to press send, and support finds
/// the log line from the code (S4-D9, S4-D32).
String supportChatMessage(String referenceCode) =>
    'Hello Look Up support, my reference code is $referenceCode.';

/// The WhatsApp address that opens a chat with Look Up support with [supportChatMessage] typed in,
/// or null when it cannot be built safely (then no link is shown).
///
/// Built by the very builder the card's WhatsApp buttons use (S4-D32), so the support link obeys
/// the same rules as every other address the app opens: an E.164 number, the text encoded as
/// `encodeURIComponent` does, and only the `https://wa.me/` prefix.
String? buildSupportChatAddress({
  required String supportWhatsAppNumber,
  required String referenceCode,
}) {
  return buildActionUri(
    WhatsAppUiAction(
      id: 'look-up-support',
      label: 'Message support on WhatsApp',
      style: ActionStyle.secondary,
      phoneNumberE164: supportWhatsAppNumber,
      prefilledText: supportChatMessage(referenceCode),
    ),
  );
}
