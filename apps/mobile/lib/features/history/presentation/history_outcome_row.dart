import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/presentation/day_label_words.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// A saved clip's outcome that is not a result (P6 design §2.9, §3.11), at least [minimumHeight]
/// tall, in a white card with a line-soft border:
/// - **waiting for a choice**: a radio icon on accent-soft, "Clip from today, 14:32", "Choose your
///   station to see the buttons" and a chevron; a button that opens "Which station?" (T51);
/// - **waiting for an account** (ADR-005): a lock on accent-soft, "Clip from today, 14:32", "Create an account to
///   see this result" and a chevron; a button that opens the account gate for it;
/// - **not identified**: a magnifying glass, muted on line-soft, "Clip from today, 14:32" and one of
///   "Not recognised", "Not sent within 24 hours — deleted", "Couldn't be checked — deleted"; not a
///   button, as there is nothing to open.
class HistoryOutcomeRow extends StatelessWidget {
  const HistoryOutcomeRow({super.key, required this.entry, required this.now, this.onTap})
    // A result has its own row, HistoryEntryRow.
    : assert(
        entry is HistoryAwaitingChoiceEntry ||
            entry is HistoryAwaitingAccountEntry ||
            entry is HistoryNotIdentifiedEntry,
      );

  static const double minimumHeight = 72;

  final HistoryEntry entry;
  final DateTime now;

  /// Opens the chooser, or the account gate; only for a clip waiting for a choice or for an account.
  final VoidCallback? onTap;

  /// The row's two lines in words.
  static ({String title, String detail}) linesOf(
    HistoryEntry entry, {
    required DateTime now,
    required AppLocalizations words,
    required Locale locale,
  }) => (
    title: words.historyClipFrom(
      DayLabelWords.dayAndTimeInSentenceOf(
        DayLabel.of(entry.capturedAtOnPhone, now: now),
        words,
        locale,
      ),
    ),
    detail: switch (entry) {
      HistoryAwaitingChoiceEntry() => words.historyAwaitingChoiceDetail,
      HistoryAwaitingAccountEntry() => words.historyAwaitingAccountDetail,
      HistoryNotIdentifiedEntry(:final reason) => switch (reason) {
        DeferredClipNotIdentifiedReason.notRecognised => words.historyNotRecognised,
        DeferredClipNotIdentifiedReason.notSentWithin24Hours => words.historyNotSentWithin24Hours,
        DeferredClipNotIdentifiedReason.couldNotBeChecked => words.historyCouldNotBeChecked,
      },
      HistoryResultEntry() => '',
    },
  );

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final lines = linesOf(
      entry,
      now: now,
      words: AppLocalizations.of(context),
      locale: Localizations.localeOf(context),
    );
    // A row that waits for the listener (a station to choose, an account to create) opens something.
    final isAwaitingChoice = entry is HistoryAwaitingChoiceEntry || entry is HistoryAwaitingAccountEntry;
    final isAwaitingAccount = entry is HistoryAwaitingAccountEntry;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(tokens.radii.large),
      side: BorderSide(color: colours.lineSoft),
    );
    final content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: minimumHeight),
      child: Padding(
        padding: EdgeInsets.all(spacing.space3),
        child: Row(
          children: [
            SizedBox.square(
              dimension: spacing.space10,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: isAwaitingChoice ? colours.accentSoft : colours.lineSoft,
                  borderRadius: BorderRadius.circular(tokens.radii.medium),
                ),
                child: Icon(
                  isAwaitingAccount
                      ? Icons.lock_outline
                      : isAwaitingChoice
                      ? Icons.radio_outlined
                      : Icons.search,
                  color: isAwaitingChoice ? colours.accent : colours.muted,
                ),
              ),
            ),
            SizedBox(width: spacing.space3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(lines.title, style: typeStyles.body.copyWith(fontWeight: FontWeight.w700)),
                  Text(lines.detail, style: typeStyles.caption.copyWith(color: colours.muted)),
                ],
              ),
            ),
            if (isAwaitingChoice) ...[
              SizedBox(width: spacing.space2),
              ExcludeSemantics(child: Icon(Icons.chevron_right, color: colours.muted)),
            ],
          ],
        ),
      ),
    );
    final onTap = this.onTap;
    if (!isAwaitingChoice || onTap == null) {
      return Semantics(
        container: true,
        label: '${lines.title}. ${lines.detail}',
        excludeSemantics: true,
        child: DecoratedBox(
          decoration: ShapeDecoration(shape: shape, color: colours.surface),
          child: content,
        ),
      );
    }
    return Semantics(
      button: true,
      label: '${lines.title}\n${lines.detail}',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: colours.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(onTap: onTap, customBorder: shape, child: content),
      ),
    );
  }
}
