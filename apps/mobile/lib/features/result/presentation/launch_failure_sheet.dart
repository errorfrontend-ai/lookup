import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';
import 'package:lookup_listener/features/result/domain/phone_number_display.dart';

/// What the "Couldn't open this" sheet offers to copy instead of the button's address (S4-D19).
/// Sealed, so the sheet words each kind with no default branch.
sealed class CopyOffer {
  const CopyOffer();

  /// Exactly what goes on the clipboard.
  String get copiedText;
}

/// A call or WhatsApp button: the number, which the listener can paste into the dialler or chat.
final class PhoneNumberCopyOffer extends CopyOffer {
  const PhoneNumberCopyOffer({required this.phoneNumberE164});

  /// Copied as it is, e.g. `+260977123456`, the form every dialler accepts.
  final String phoneNumberE164;

  /// Shown on the sheet the way a person reads it, e.g. `+260 97 712 3456`.
  String get displayedPhoneNumber => formatPhoneNumberForDisplay(phoneNumberE164);

  @override
  String get copiedText => phoneNumberE164;
}

/// A map or link button: the address the app built, which the listener can paste into a browser.
final class LinkCopyOffer extends CopyOffer {
  const LinkCopyOffer({required this.address});

  /// The address `buildActionUri` made: never one the server supplied for a map.
  final String address;

  @override
  String get copiedText => address;
}

/// The bottom sheet shown when the phone could not open a button's address (design §2.6, S4-D19):
/// it says so plainly and offers to copy the number or the link instead, so the listener can still
/// reach the advertiser. After a copy it closes and confirms with a snackbar.
class LaunchFailureSheet extends ConsumerWidget {
  const LaunchFailureSheet({super.key, required this.offer});

  /// What can be copied instead.
  final CopyOffer offer;

  /// Shows the sheet over [context]'s screen; completes when it closes.
  static Future<void> show(BuildContext context, CopyOffer offer) {
    return showModalBottomSheet<void>(
      context: context,
      // Lets the sheet grow and scroll when the text is large, instead of being cut at half height.
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.lookUpTokens.colours.surface,
      builder: (context) => LaunchFailureSheet(offer: offer),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final offer = this.offer;
    final (explanation, copyLabel) = switch (offer) {
      PhoneNumberCopyOffer() => (
        "Your phone couldn't open it. You can copy the number instead.",
        'Copy number',
      ),
      LinkCopyOffer() => (
        "Your phone couldn't open it. You can copy the link instead.",
        'Copy link',
      ),
    };
    return SingleChildScrollView(
      child: Padding(
        padding: EdgeInsets.all(spacing.space6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(header: true, child: Text("Couldn't open this", style: typeStyles.title)),
            SizedBox(height: spacing.space2),
            Text(explanation, style: typeStyles.body.copyWith(color: tokens.colours.muted)),
            if (offer is PhoneNumberCopyOffer) ...[
              SizedBox(height: spacing.space4),
              Text(offer.displayedPhoneNumber, style: typeStyles.heading),
            ],
            SizedBox(height: spacing.space6),
            FilledButton(onPressed: () => _copy(context, ref), child: Text(copyLabel)),
            SizedBox(height: spacing.space2),
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
          ],
        ),
      ),
    );
  }

  Future<void> _copy(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final confirmation = switch (offer) {
      PhoneNumberCopyOffer() => 'Number copied',
      LinkCopyOffer() => 'Link copied',
    };
    final hasCopied = await ref.read(clipboardWriterProvider).copyText(offer.copiedText);
    // Confirm only a copy that happened; otherwise the sheet stays, with "Close" to leave.
    if (!hasCopied) return;
    navigator.pop();
    messenger.showSnackBar(SnackBar(content: Text(confirmation)));
  }
}
