import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/identify/data/how_it_works_note_store.dart';

/// Whether Home shows the "How Look Up works" note in this launch (P6 design §2.3, §3.6, P6-D40;
/// ALL-USABILITY-04): on the first launch only.
///
/// - It starts hidden, and shows once the stored flag says no launch has shown it yet.
/// - [markShown] records the note as shown as soon as it has been drawn once, so a later launch
///   never shows it, whether or not it was dismissed; the flag is written once per launch.
/// - "Got it" ([dismiss]) hides it for the rest of this launch.
///
/// A flag that cannot be read leaves the note hidden; a flag that cannot be written lets the note
/// show once more. Either failure goes on to the app's own handler for errors nobody caught, which
/// reports it (S4-D26): neither changes what the listener can do.
class HowItWorksNote extends Notifier<bool> {
  bool _isMarked = false;

  @override
  bool build() {
    unawaited(_showUnlessShownBefore());
    return false;
  }

  /// Called once the note has been drawn: no later launch shows it.
  Future<void> markShown() async {
    if (_isMarked) return;
    _isMarked = true;
    await ref.read(howItWorksNoteStoreProvider).markShown();
  }

  /// "Got it": hides the note for the rest of this launch.
  void dismiss() => state = false;

  Future<void> _showUnlessShownBefore() async {
    final wasShown = await ref.read(howItWorksNoteStoreProvider).wasShown();
    if (ref.mounted && !wasShown && !_isMarked) state = true;
  }
}

/// Whether Home shows its first-open note in this launch. Kept for the app's life, so "Got it"
/// holds while the listener moves between tabs.
final NotifierProvider<HowItWorksNote, bool> howItWorksNoteProvider =
    NotifierProvider<HowItWorksNote, bool>(HowItWorksNote.new, retry: (retryCount, error) => null);
