import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

/// A result opened again from History, at `/r/<recognition id>` (P6 design §2.10; P6-STRUCTURE-02,
/// P6-HISTORY-11): the Result screen filled from History with no request, so its buttons work with
/// no data (P6-HISTORY-02). Composed here, where History and the Result meet (§3.2).
///
/// It reads only this phone's History, so no other install can open it. An id History does not hold
/// — no longer saved, or not a recognition id at all — calls [onMissing], which goes to the History
/// tab and says "That result is no longer saved on this phone." While History is first read, the
/// page is blank for a moment.
///
/// The History view can lag behind the files: Riverpod pauses it while no screen on show watches
/// it, so a result the outbox saved while another tab showed may not be in it yet when a
/// notification opens the result. An id the view does not hold is therefore looked up in History
/// itself before [onMissing] is called, and [onMissing] waits until this page has finished
/// arriving, so the tab shell it goes back to is never built while the old one is still leaving.
class SavedResultPage extends ConsumerStatefulWidget {
  const SavedResultPage({
    super.key,
    required this.recognitionId,
    required this.onBack,
    required this.onMissing,
  });

  /// The id in the location, as it came: checked only by looking it up in History.
  final String recognitionId;

  /// Back: where the saved result was opened from.
  final VoidCallback onBack;

  /// History does not hold [recognitionId].
  final VoidCallback onMissing;

  @override
  ConsumerState<SavedResultPage> createState() => _SavedResultPageState();
}

class _SavedResultPageState extends ConsumerState<SavedResultPage> {
  bool _isLookingInHistory = false;

  /// The entry History itself held when the view did not yet.
  HistoryResultEntry? _entryReadFromHistory;

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(historyViewProvider);
    final entry = view.value?.resultFor(widget.recognitionId) ?? _entryReadFromHistory;
    if (entry != null) {
      return ResultScreen.saved(result: entry.result, onBack: widget.onBack);
    }
    if (view is! AsyncLoading && !_isLookingInHistory) {
      _isLookingInHistory = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _lookInHistory());
    }
    return const Scaffold();
  }

  Future<void> _lookInHistory() async {
    HistoryResultEntry? entry;
    try {
      entry = (await ref.read(historyRepositoryProvider).readView()).resultFor(
        widget.recognitionId,
      );
    } on Object {
      // History that cannot be read holds nothing to show; reading it reports its own failure.
      entry = null;
    }
    if (!mounted) return;
    if (entry != null) {
      setState(() => _entryReadFromHistory = entry);
    } else {
      _leaveOnceArrived();
    }
  }

  void _leaveOnceArrived() {
    final arrival = ModalRoute.of(context)?.animation;
    if (arrival == null || arrival.isCompleted) {
      widget.onMissing();
      return;
    }
    void whenArrived(AnimationStatus status) {
      if (!status.isCompleted) return;
      arrival.removeStatusListener(whenArrived);
      if (mounted) widget.onMissing();
    }

    arrival.addStatusListener(whenArrived);
  }
}
