import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Whether Home has shown the "How Look Up works" note (P6 design §2.3, P6-D40; ALL-USABILITY-04):
/// the `shared_preferences` flag `how_it_works_note_shown`, app-private and kept until the app is
/// removed (§3.22).
///
/// It is written as soon as the note has been drawn once, not only when "Got it" is tapped, so a
/// later launch never shows it again whether or not it was dismissed. Only the foreground engine
/// writes it (§3.12). A failure to read or write is thrown to the caller.
class HowItWorksNoteStore {
  /// [openPreferences] is for tests; the app uses `SharedPreferences.getInstance`.
  HowItWorksNoteStore({Future<SharedPreferences> Function()? openPreferences})
    : _openPreferences = openPreferences ?? SharedPreferences.getInstance;

  /// The storage key, exactly as the design names it.
  static const String shownKey = 'how_it_works_note_shown';

  final Future<SharedPreferences> Function() _openPreferences;

  /// Whether the note was shown on an earlier launch.
  Future<bool> wasShown() async {
    final preferences = await _openPreferences();
    return preferences.getBool(shownKey) ?? false;
  }

  /// Records that the note has been shown, so no later launch shows it.
  Future<void> markShown() async {
    final preferences = await _openPreferences();
    final isWritten = await preferences.setBool(shownKey, true);
    if (!isWritten) throw const HowItWorksNoteNotWritten();
  }
}

/// The phone's storage refused to keep the note's flag; the note may then show once more.
final class HowItWorksNoteNotWritten implements Exception {
  const HowItWorksNoteNotWritten();

  @override
  String toString() => 'HowItWorksNoteNotWritten: the phone did not keep the note flag';
}

/// Where Home's first-open flag is kept. Tests override it, or give `shared_preferences` its mock
/// values.
final Provider<HowItWorksNoteStore> howItWorksNoteStoreProvider = Provider<HowItWorksNoteStore>(
  (ref) => HowItWorksNoteStore(),
  retry: (retryCount, error) => null,
);
