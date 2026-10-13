import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';
import 'package:lookup_listener/features/history/presentation/day_label_words.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// A clip still waiting in the outbox (P6 design §2.9; wireframe History, section 1; P6-HISTORY-04,
/// -05): a 40 dp warning-soft square with the crossed-out signal, "Clip from today, 14:32", why it
/// waits, and "Pending" in a warning-soft pill, always in words (P6-ACCESSIBILITY-04). At least
/// [minimumHeight] tall, in a white card with a line-soft border.
///
/// Not a button: there is nothing to open yet. Read as one item: "Clip from today, 14:32. Will
/// identify when you're back online. Pending".
class WaitingClipRow extends StatelessWidget {
  const WaitingClipRow({super.key, required this.clip, required this.now});

  static const double minimumHeight = 72;

  final HistoryWaitingClip clip;
  final DateTime now;

  /// The row's three parts in words.
  static ({String title, String detail, String badge}) linesOf(
    HistoryWaitingClip clip, {
    required DateTime now,
    required AppLocalizations words,
    required Locale locale,
  }) => (
    title: words.historyClipFrom(
      DayLabelWords.dayAndTimeInSentenceOf(
        DayLabel.of(clip.capturedAtOnPhone, now: now),
        words,
        locale,
      ),
    ),
    detail: switch (clip.status) {
      HistoryWaitingClipStatus.waitingForSignal => words.historyWaitingForSignal,
      HistoryWaitingClipStatus.busy => words.historyWaitingBusy,
      HistoryWaitingClipStatus.waitingForUpdate => words.historyWaitingForUpdate,
    },
    badge: words.historyPendingBadge,
  );

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final lines = linesOf(
      clip,
      now: now,
      words: AppLocalizations.of(context),
      locale: Localizations.localeOf(context),
    );
    return Semantics(
      container: true,
      label: '${lines.title}. ${lines.detail}. ${lines.badge}',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colours.surface,
          border: Border.all(color: colours.lineSoft),
          borderRadius: BorderRadius.circular(tokens.radii.large),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minimumHeight),
          child: Padding(
            padding: EdgeInsets.all(spacing.space3),
            child: Row(
              children: [
                SizedBox.square(
                  dimension: spacing.space10,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colours.warningSoft,
                      borderRadius: BorderRadius.circular(tokens.radii.medium),
                    ),
                    child: Icon(Icons.signal_cellular_off_outlined, color: colours.warning),
                  ),
                ),
                SizedBox(width: spacing.space3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        lines.title,
                        style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
                      ),
                      Text(lines.detail, style: typeStyles.caption.copyWith(color: colours.muted)),
                    ],
                  ),
                ),
                SizedBox(width: spacing.space2),
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colours.warningSoft,
                    borderRadius: BorderRadius.circular(tokens.radii.pill),
                  ),
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: spacing.space2,
                      vertical: spacing.space1,
                    ),
                    child: Text(
                      lines.badge,
                      style: typeStyles.caption.copyWith(
                        color: colours.warning,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
