import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';

/// "My station" as the screens show it (P6 design §3.6, §3.13): Home's chip, the Settings row and
/// the picker all watch it, so a station chosen in one place shows in the others at once
/// (P6-NAVIGATION-03, P6-SETTINGS-03).
///
/// It reads [MyStationStore] when first watched, and every change goes through it: the picker
/// ([choose], [clear]) and "Remember my station" in the chooser ([choose]). A change is written
/// first and shown after, so the screens never show a station the phone did not keep; a write the
/// phone refuses is thrown to the caller, and the shown station stays as it was.
///
/// A stored value that cannot be read reads as no station, as the store reads it for the hint, so
/// the chip says "Not set" exactly when the app sends no hint. The recognition flow still reads the
/// store itself for the hint, at capture (T1′), so a clip's hint never waits for a screen.
class MyStationSetting extends AsyncNotifier<ListenerStation?> {
  @override
  Future<ListenerStation?> build() => ref.watch(myStationStoreProvider).read();

  /// Makes [station] "My station", replacing any other; its logo is not kept.
  Future<void> choose(ListenerStation station) async {
    await _settled();
    final kept = station.withoutLogo();
    await ref.read(myStationStoreProvider).remember(kept);
    if (ref.mounted) state = AsyncData(kept);
  }

  /// The picker's "No station": none is kept, and Look Up asks each time.
  Future<void> clear() async {
    await _settled();
    await ref.read(myStationStoreProvider).clear();
    if (ref.mounted) state = const AsyncData(null);
  }

  /// Waits for the first read to end, whatever it found, so it can never land after a change and
  /// show the station as it was before.
  Future<void> _settled() async {
    try {
      await future;
    } on Object {
      // A read that failed changes nothing about the write that follows.
    }
  }
}
