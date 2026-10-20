import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/section_heading.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';
import 'package:lookup_listener/features/history/presentation/history_empty_state.dart';
import 'package:lookup_listener/features/history/presentation/history_entry_row.dart';
import 'package:lookup_listener/features/history/presentation/history_outcome_row.dart';
import 'package:lookup_listener/features/history/presentation/waiting_clip_row.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The History tab at `/history` (P6 design §2.9; wireframe History): "History"; then, while clips
/// wait in the outbox, "Waiting for signal" with a Pending row each, oldest first (P6-HISTORY-04 to
/// -06); then under "Earlier" everything saved, newest first by the phone's capture time: the
/// results the listener saw, each opening its saved result, a saved clip still waiting for its
/// station, which opens "Which station?" (T51), and saved clips that were never identified; and
/// under them "Saved results keep working without data — call, chat or get directions any time."
/// With nothing at all, a designed empty state instead (P6-HISTORY-03, -07 to -13).
///
/// It follows History and the outbox as they change: a clip queued or answered while it is open
/// shows at once. A row's tap goes to [onOpenResult] or [onOpenSavedChooser], given by the tab
/// shell, which knows the routes. The tab bar is the shell's, with History marked as the current
/// tab (P6-NAVIGATION-05).
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({
    super.key,
    required this.onOpenResult,
    required this.onOpenSavedChooser,
    this.onOpenSavedAccountGate,
  });

  /// Opens the saved result of a recognition id.
  final ValueChanged<String> onOpenResult;

  /// Opens "Which station?" for a saved clip waiting for its station.
  final ValueChanged<HistoryAwaitingChoiceEntry> onOpenSavedChooser;

  /// Opens the account gate for a scan whose result waits for the listener's account (ADR-005).
  final ValueChanged<HistoryAwaitingAccountEntry>? onOpenSavedAccountGate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final view = ref.watch(historyViewProvider);
    return ScreenFrame(
      title: Semantics(
        header: true,
        child: Text(words.historyHeading, style: tokens.typeStyles.title),
      ),
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space4,
        spacing.space5,
        spacing.space4,
        spacing.space6,
      ),
      body: switch (view) {
        AsyncData(:final value) when value.isEmpty => const HistoryEmptyState(),
        AsyncData(:final value) => _SavedResults(
          view: value,
          now: ref.watch(historyClockProvider).now(),
          onOpenResult: onOpenResult,
          onOpenSavedChooser: onOpenSavedChooser,
          onOpenSavedAccountGate: onOpenSavedAccountGate,
        ),
        // Read in a moment; a History that cannot be read was reported, and shows nothing rather
        // than an empty History it does not know to be empty.
        AsyncLoading() || AsyncError() => const SizedBox.shrink(),
      },
    );
  }
}

/// "Waiting for signal" and its rows, "Earlier" and its rows, and the note under them.
class _SavedResults extends StatelessWidget {
  const _SavedResults({
    required this.view,
    required this.now,
    required this.onOpenResult,
    required this.onOpenSavedChooser,
    required this.onOpenSavedAccountGate,
  });

  final HistoryView view;
  final DateTime now;
  final ValueChanged<String> onOpenResult;
  final ValueChanged<HistoryAwaitingChoiceEntry> onOpenSavedChooser;
  final ValueChanged<HistoryAwaitingAccountEntry>? onOpenSavedAccountGate;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final results = view.results;
    final waitingClips = view.waitingClips;
    final entries = view.entries;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Only while a clip waits (P6-HISTORY-06).
        if (waitingClips.isNotEmpty) ...[
          SectionHeading(text: words.historyWaitingHeading),
          SizedBox(height: spacing.space2),
          for (final (position, clip) in waitingClips.indexed) ...[
            if (position > 0) SizedBox(height: spacing.space2),
            WaitingClipRow(key: ValueKey(clip.idempotencyKey), clip: clip, now: now),
          ],
          if (entries.isNotEmpty) SizedBox(height: spacing.space5),
        ],
        if (entries.isNotEmpty) ...[
          SectionHeading(text: words.historyEarlierHeading),
          SizedBox(height: spacing.space2),
        ],
        for (final (position, entry) in entries.indexed) ...[
          if (position > 0) SizedBox(height: spacing.space2),
          _row(entry, position),
        ],
        // Only under saved results: it says what they are good for (P6-HISTORY-12).
        if (results.isNotEmpty) ...[
          SizedBox(height: spacing.space4),
          Text(
            words.historyOfflineNote,
            style: tokens.typeStyles.caption.copyWith(color: tokens.colours.muted),
          ),
        ],
      ],
    );
  }

  Widget _row(HistoryEntry entry, int position) => switch (entry) {
    HistoryResultEntry() => HistoryEntryRow(
      key: ValueKey(entry.entryId),
      entry: entry,
      position: position,
      now: now,
      onTap: () => onOpenResult(entry.entryId),
    ),
    HistoryAwaitingChoiceEntry() => HistoryOutcomeRow(
      key: ValueKey(entry.entryId),
      entry: entry,
      now: now,
      onTap: () => onOpenSavedChooser(entry),
    ),
    HistoryAwaitingAccountEntry() => HistoryOutcomeRow(
      key: ValueKey(entry.entryId),
      entry: entry,
      now: now,
      onTap: switch (onOpenSavedAccountGate) {
        final open? => () => open(entry),
        null => null,
      },
    ),
    HistoryNotIdentifiedEntry() => HistoryOutcomeRow(
      key: ValueKey(entry.entryId),
      entry: entry,
      now: now,
    ),
  };
}
