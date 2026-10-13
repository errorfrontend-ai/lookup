import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_reporting.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// "Report this ad" (P6 design §2.14; Q6): a sheet over the Result with its handle, the four reasons
/// as radio rows (the whole 48 dp row chooses), "Send report", enabled once a reason is chosen, and
/// "Cancel". Dragging it down or Back is Cancel. No free text is collected.
class ReportSheet extends StatefulWidget {
  const ReportSheet({super.key});

  /// Shows the sheet; completes with the reason the listener sent, or null when they cancelled. It
  /// slides in over motion.slow and out over motion.base, at once when the phone asks for less
  /// motion.
  static Future<RecognitionReportReason?> show(BuildContext context) {
    final tokens = context.lookUpTokens;
    return showModalBottomSheet<RecognitionReportReason>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: tokens.colours.surface,
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: tokens.motion.slow, reverseDuration: tokens.motion.base),
      builder: (context) => const ReportSheet(),
    );
  }

  /// Each reason's words, in the order the sheet lists them.
  static String wordsFor(
    RecognitionReportReason reason,
    AppLocalizations words,
  ) => switch (reason) {
    RecognitionReportReason.wrongOrMisleadingButtons => words.reportReasonWrongOrMisleadingButtons,
    RecognitionReportReason.numberOrLinkDoesNotWork => words.reportReasonNumberOrLinkDoesNotWork,
    RecognitionReportReason.looksLikeAScam => words.reportReasonLooksLikeAScam,
    RecognitionReportReason.somethingElse => words.reportReasonSomethingElse,
  };

  @override
  State<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<ReportSheet> {
  RecognitionReportReason? _reason;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final reason = _reason;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(spacing.space6, 0, spacing.space6, spacing.space6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Semantics(header: true, child: Text(words.reportSheetTitle, style: typeStyles.heading)),
          SizedBox(height: spacing.space2),
          Text(words.reportSheetText, style: typeStyles.body.copyWith(color: tokens.colours.muted)),
          SizedBox(height: spacing.space3),
          RadioGroup<RecognitionReportReason>(
            groupValue: reason,
            onChanged: (chosen) => setState(() => _reason = chosen),
            child: Column(
              children: [
                for (final option in RecognitionReportReason.values)
                  RadioListTile<RecognitionReportReason>(
                    value: option,
                    contentPadding: EdgeInsets.zero,
                    title: Text(ReportSheet.wordsFor(option, words), style: typeStyles.body),
                  ),
              ],
            ),
          ),
          SizedBox(height: spacing.space4),
          FilledButton(
            onPressed: reason == null ? null : () => Navigator.of(context).pop(reason),
            child: Text(words.reportSendButton),
          ),
          SizedBox(height: spacing.space2),
          TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(words.cancelButton)),
        ],
      ),
    );
  }
}
