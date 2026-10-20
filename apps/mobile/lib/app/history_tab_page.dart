import 'package:flutter/material.dart';
import 'package:lookup_listener/app/saved_result_page.dart';
import 'package:lookup_listener/app/two_panes.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/presentation/history_screen.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The History tab (P6 design §3.19): the list on a phone and at medium width, where a row opens its
/// saved result as a page of its own; at expanded width the list and, beside it, the saved result
/// last opened, or a line saying where it will show.
class HistoryTabPage extends StatefulWidget {
  const HistoryTabPage({
    super.key,
    required this.onOpenResultPage,
    required this.onOpenSavedChooser,
    this.onOpenSavedAccountGate,
  });

  /// A row's tap below expanded width: the saved result as a page (`/r/<id>`).
  final ValueChanged<String> onOpenResultPage;

  /// A clip waiting for its station: "Which station?" (T51).
  final ValueChanged<HistoryAwaitingChoiceEntry> onOpenSavedChooser;

  /// A scan whose result waits for the listener's account: the account gate (ADR-005).
  final ValueChanged<HistoryAwaitingAccountEntry>? onOpenSavedAccountGate;

  @override
  State<HistoryTabPage> createState() => _HistoryTabPageState();
}

class _HistoryTabPageState extends State<HistoryTabPage> {
  /// The recognition shown beside the list at expanded width.
  String? _openedRecognitionId;

  @override
  Widget build(BuildContext context) {
    final isExpanded = WindowSizeClass.of(context) == WindowSizeClass.expanded;
    final list = HistoryScreen(
      onOpenResult: (recognitionId) => isExpanded
          ? setState(() => _openedRecognitionId = recognitionId)
          : widget.onOpenResultPage(recognitionId),
      onOpenSavedChooser: widget.onOpenSavedChooser,
      onOpenSavedAccountGate: widget.onOpenSavedAccountGate,
    );
    if (!isExpanded) return list;
    final words = AppLocalizations.of(context);
    final opened = _openedRecognitionId;
    return TwoPanes(
      start: list,
      end: opened == null
          ? PaneNote(text: words.historyPaneNote)
          : SavedResultPage(
              key: ValueKey(opened),
              recognitionId: opened,
              onBack: _close,
              onMissing: () {
                _close();
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text(words.savedResultMissing)),
                  snackBarAnimationStyle: AnimationStyle.noAnimation,
                );
              },
            ),
    );
  }

  void _close() {
    if (mounted) setState(() => _openedRecognitionId = null);
  }
}
