import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';

/// The Error screen's reference code (design §2.10, S4-D9; wireframe Error): "Reference code" over
/// the code in the phone's monospace font, e.g. "6F1C-2D3E", and a "Copy" button that puts the
/// code, exactly as shown, on the clipboard and confirms with "Code copied".
///
/// The code is the first 8 hex digits of a request id the API logged, so support finds the log
/// line from it; the screen shows the panel only when such an id exists.
class ReferenceCodePanel extends ConsumerWidget {
  const ReferenceCodePanel({super.key, required this.referenceCode});

  /// E.g. "6F1C-2D3E".
  final String referenceCode;

  static const String label = 'Reference code';

  static const String copyLabel = 'Copy';

  static const String copiedConfirmation = 'Code copied';

  /// The phone's own monospace font: "monospace" on Android, with the iPhone's equivalents after
  /// it. No font file is shipped (S4-THEME-04).
  static const String monospaceFontFamily = 'monospace';
  static const List<String> monospaceFontFallbacks = ['Menlo', 'Courier'];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colours.surface,
        border: Border.all(color: colours.lineSoft),
        borderRadius: BorderRadius.circular(tokens.radii.large),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          spacing.space4,
          spacing.space3,
          spacing.space3,
          spacing.space3,
        ),
        // The code and "Copy" share a line; "Copy" moves under the code when the text is large.
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: spacing.space3,
          runSpacing: spacing.space2,
          children: [
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: typeStyles.caption.copyWith(
                    color: colours.muted,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  referenceCode,
                  style: typeStyles.heading.copyWith(
                    fontFamily: monospaceFontFamily,
                    fontFamilyFallback: monospaceFontFallbacks,
                    fontWeight: FontWeight.w700,
                    // 1 dp, a quarter of the smallest spacing step, as the wireframe spaces it.
                    letterSpacing: spacing.space1 / 4,
                  ),
                ),
              ],
            ),
            OutlinedButton(
              onPressed: () => _copy(context, ref),
              style: OutlinedButton.styleFrom(
                minimumSize: Size.square(tokens.sizes.touchTargetMinimum),
                padding: EdgeInsets.symmetric(horizontal: spacing.space4),
                textStyle: typeStyles.label,
              ),
              child: const Text(copyLabel),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _copy(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final motion = context.lookUpTokens.motion;
    final disablesAnimations = MediaQuery.disableAnimationsOf(context);
    final hasCopied = await ref.read(clipboardWriterProvider).copyText(referenceCode);
    // Confirm only a copy that happened.
    if (!hasCopied) return;
    messenger.showSnackBar(
      const SnackBar(content: Text(copiedConfirmation)),
      // In and out over motion.base (S4-ACCESSIBILITY-04); no slide when the phone asks for less
      // motion ("Remove animations").
      snackBarAnimationStyle: disablesAnimations
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: motion.base, reverseDuration: motion.base),
    );
  }
}
