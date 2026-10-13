import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

/// A result opened again from History, at `/r/<recognition id>` (P6 design §2.10; P6-STRUCTURE-02,
/// P6-HISTORY-11): the Result screen filled from History with no request, so its buttons work with
/// no data (P6-HISTORY-02). Composed here, where History and the Result meet (§3.2).
///
/// It reads only this phone's History, so no other install can open it. An id History does not hold
/// — no longer saved, or not a recognition id at all — calls [onMissing], which goes to the History
/// tab and says "That result is no longer saved on this phone." While History is first read, the
/// page is blank for a moment.
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
  bool _isMissingHandled = false;

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(historyViewProvider);
    final entry = view.value?.resultFor(widget.recognitionId);
    if (entry != null) return ResultScreen.saved(result: entry.result, onBack: widget.onBack);
    if (view is! AsyncLoading && !_isMissingHandled) {
      _isMissingHandled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onMissing();
      });
    }
    return const Scaffold();
  }
}
