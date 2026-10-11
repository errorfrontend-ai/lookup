import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/domain/support_chat_address.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// "Message support on WhatsApp", under the Error screen's reference code (S4-D32): it opens a
/// WhatsApp chat with Look Up support with "Hello Look Up support, my reference code is
/// [code]." typed in, so the listener only has to press send.
///
/// The address comes from the same builder as the card's WhatsApp buttons, and it opens the same
/// way; when the phone cannot open it, the same sheet offers to copy support's number instead.
/// The Error screen shows it only when the build has a support number, so a code is never
/// offered with a promise of support that cannot be reached.
class SupportChatButton extends ConsumerWidget {
  const SupportChatButton({
    super.key,
    required this.supportWhatsAppNumber,
    required this.referenceCode,
  });

  /// Support's WhatsApp number in E.164, from the build's configuration.
  final String supportWhatsAppNumber;

  /// The code the message carries, e.g. "6F1C-2D3E".
  final String referenceCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final words = AppLocalizations.of(context);
    final address = buildSupportChatAddress(
      supportWhatsAppNumber: supportWhatsAppNumber,
      message: words.supportChatMessage(referenceCode),
    );
    // An address that cannot be built safely gives no link at all, never a dead one.
    if (address == null) return const SizedBox.shrink();
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: TextButton.icon(
        onPressed: () => _open(context, ref, address),
        // Decorative: the words say where it leads.
        icon: Icon(Icons.chat_bubble_outline, size: context.lookUpTokens.spacing.space5),
        label: Text(words.supportChatButton),
      ),
    );
  }

  Future<void> _open(BuildContext context, WidgetRef ref, String address) async {
    final hasOpened = await ref.read(actionLauncherProvider).open(address);
    if (hasOpened || !context.mounted) return;
    await LaunchFailureSheet.show(
      context,
      PhoneNumberCopyOffer(phoneNumberE164: supportWhatsAppNumber),
    );
  }
}
