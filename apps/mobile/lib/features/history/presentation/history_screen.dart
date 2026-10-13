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
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The History tab at `/history` (P6 design §2.9; wireframe History): "History", then the results
/// the listener saw under "Earlier", newest first by the phone's capture time, each opening its
/// saved result, and under them "Saved results keep working without data — call, chat or get
/// directions any time." With nothing saved, a designed empty state instead (P6-HISTORY-03, -07 to
/// -13). The clips still waiting for a signal ("Waiting for signal", "Pending") join it in piece 3.
///
/// It follows History as it changes: a result saved while it is open appears at once. A row's tap
/// goes to [onOpenResult], given by the tab shell, which knows the routes. The tab bar is the
/// shell's, with History marked as the current tab (P6-NAVIGATION-05).
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key, required this.onOpenResult});

  /// Opens the saved result of a recognition id.
  final ValueChanged<String> onOpenResult;

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
        ),
        // Read in a moment; a History that cannot be read was reported, and shows nothing rather
        // than an empty History it does not know to be empty.
        AsyncLoading() || AsyncError() => const SizedBox.shrink(),
      },
    );
  }
}

/// "Earlier", the rows, and the note under them.
class _SavedResults extends StatelessWidget {
  const _SavedResults({required this.view, required this.now, required this.onOpenResult});

  final HistoryView view;
  final DateTime now;
  final ValueChanged<String> onOpenResult;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final results = view.results;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionHeading(text: words.historyEarlierHeading),
        SizedBox(height: spacing.space2),
        for (final (position, entry) in results.indexed) ...[
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

  Widget _row(HistoryResultEntry entry, int position) => HistoryEntryRow(
    key: ValueKey(entry.entryId),
    entry: entry,
    position: position,
    now: now,
    onTap: () => onOpenResult(entry.entryId),
  );
}
