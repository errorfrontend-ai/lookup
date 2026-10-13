import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where "Load ad pictures on mobile data" is kept (P6 design §3.16): `shared_preferences`, which
/// only the foreground engine reads.
class PictureSettingStore {
  /// [openPreferences] is for tests; the app uses `SharedPreferences.getInstance`.
  PictureSettingStore({Future<SharedPreferences> Function()? openPreferences})
    : _openPreferences = openPreferences ?? SharedPreferences.getInstance;

  static const String loadsPicturesOnMobileDataKey = 'load_pictures_on_mobile_data';

  final Future<SharedPreferences> Function() _openPreferences;

  /// On until the listener turns it off (P6-DATASAVER-04).
  Future<bool> readLoadsPicturesOnMobileData() async =>
      (await _openPreferences()).getBool(loadsPicturesOnMobileDataKey) ?? true;

  Future<void> rememberLoadsPicturesOnMobileData(bool isOn) async {
    await (await _openPreferences()).setBool(loadsPicturesOnMobileDataKey, isOn);
  }
}

final Provider<PictureSettingStore> pictureSettingStoreProvider = Provider<PictureSettingStore>(
  (ref) => PictureSettingStore(),
  retry: (retryCount, error) => null,
);

/// The switch as Settings shows it and changes it.
class LoadsPicturesOnMobileData extends AsyncNotifier<bool> {
  @override
  Future<bool> build() => ref.watch(pictureSettingStoreProvider).readLoadsPicturesOnMobileData();

  Future<void> set(bool isOn) async {
    state = AsyncData(isOn);
    await ref.read(pictureSettingStoreProvider).rememberLoadsPicturesOnMobileData(isOn);
  }
}
