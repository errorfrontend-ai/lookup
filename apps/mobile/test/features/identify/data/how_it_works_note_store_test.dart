import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/data/how_it_works_note_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Whether Home's first-open note has been shown (P6 design §2.3, §3.22; ALL-USABILITY-04).
void main() {
  test('not shown on a first launch (nothing stored)', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await HowItWorksNoteStore().wasShown(), isFalse);
  });

  test('shown once it is marked, under how_it_works_note_shown, for every later launch', () async {
    SharedPreferences.setMockInitialValues({});
    await HowItWorksNoteStore().markShown();
    final preferences = await SharedPreferences.getInstance();
    expect(preferences.getBool('how_it_works_note_shown'), isTrue);
    expect(await HowItWorksNoteStore().wasShown(), isTrue);
  });
}
