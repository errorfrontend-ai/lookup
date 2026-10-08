import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The microphone permission, as the recognition flow needs it (design §3.16, S4-D22): read the
/// status without showing anything, ask the system only when the listener taps "Allow microphone",
/// and open the app's page in the phone's settings.
///
/// An interface, so the flow is tested without a platform, and so nothing above the data layer
/// touches `package:permission_handler`. Failures of the platform are thrown to the flow, which
/// reports them.
abstract interface class MicrophonePermission {
  /// What the phone says now, read without any prompt: never shows the system dialog
  /// (S4-PERMISSION-01). Identify reads this before every capture (T1, T2) and on coming back from
  /// the phone's settings (T7).
  Future<MicrophoneAccess> readAccess();

  /// Shows the system prompt and gives the listener's answer. Called only by "Allow microphone"
  /// (S4-PERMISSION-02; T3 to T5). Never gives [MicrophoneAccess.notAskedYet].
  Future<MicrophoneAccess> requestAccess();

  /// Opens Look Up's page in the phone's settings (T6). Resolves to whether it opened; never
  /// throws.
  Future<bool> openSettings();
}

/// The permission through `permission_handler` 12.0.3 (S4-D33).
///
/// - Granted (or iOS's limited and provisional) → granted.
/// - Permanently denied or restricted → refused for good: only the phone's settings can help.
/// - Denied: "not asked yet" until this install has once shown the prompt (the
///   `has_asked_for_microphone` flag), "refused once" after that.
///
/// On Android, 12.x reports "permanently denied" only as the result of a request, never from a
/// status check, so a tap on "Allow microphone" that is refused at once, with no prompt, is how the
/// app learns the system will not ask again (T5). `record`'s `hasPermission` is never used: by
/// default it shows the prompt itself (§3.16).
final class PermissionHandlerMicrophonePermission implements MicrophonePermission {
  /// The parameters are for tests; the app uses `permission_handler` and `shared_preferences`.
  PermissionHandlerMicrophonePermission({
    Future<PermissionStatus> Function()? readStatus,
    Future<PermissionStatus> Function()? requestStatus,
    Future<bool> Function()? openAppSettingsPage,
    Future<SharedPreferences> Function()? openPreferences,
  }) : _readStatus = readStatus ?? _readMicrophoneStatus,
       _requestStatus = requestStatus ?? _requestMicrophoneStatus,
       _openAppSettingsPage = openAppSettingsPage ?? openAppSettings,
       _openPreferences = openPreferences ?? SharedPreferences.getInstance;

  /// Set once this install has shown the system prompt, so a later "denied" reads as refused once.
  static const String hasAskedKey = 'has_asked_for_microphone';

  final Future<PermissionStatus> Function() _readStatus;
  final Future<PermissionStatus> Function() _requestStatus;
  final Future<bool> Function() _openAppSettingsPage;
  final Future<SharedPreferences> Function() _openPreferences;

  @override
  Future<MicrophoneAccess> readAccess() async => switch (await _readStatus()) {
    PermissionStatus.granted ||
    PermissionStatus.limited ||
    PermissionStatus.provisional => MicrophoneAccess.granted,
    PermissionStatus.permanentlyDenied ||
    PermissionStatus.restricted => MicrophoneAccess.refusedForGood,
    PermissionStatus.denied =>
      await _hasAsked() ? MicrophoneAccess.refusedOnce : MicrophoneAccess.notAskedYet,
  };

  @override
  Future<MicrophoneAccess> requestAccess() async {
    // Remembered before the prompt shows, so an app stopped during it still knows it asked.
    await _rememberAsked();
    return switch (await _requestStatus()) {
      PermissionStatus.granted ||
      PermissionStatus.limited ||
      PermissionStatus.provisional => MicrophoneAccess.granted,
      PermissionStatus.permanentlyDenied ||
      PermissionStatus.restricted => MicrophoneAccess.refusedForGood,
      PermissionStatus.denied => MicrophoneAccess.refusedOnce,
    };
  }

  @override
  Future<bool> openSettings() async {
    try {
      return await _openAppSettingsPage();
    } on Exception {
      // No settings page could be opened (a `PlatformException`): the screen stays as it is.
      return false;
    }
  }

  /// The flag only chooses between two wordings of the same screen, so a storage failure reads as
  /// "never asked" rather than stopping an identify.
  Future<bool> _hasAsked() async {
    try {
      return (await _openPreferences()).getBool(hasAskedKey) ?? false;
    } on Exception {
      return false;
    }
  }

  Future<void> _rememberAsked() async {
    try {
      await (await _openPreferences()).setBool(hasAskedKey, true);
    } on Exception {
      // Not remembered: a later refusal reads as "not asked yet", whose button asks again anyway.
    }
  }

  static Future<PermissionStatus> _readMicrophoneStatus() => Permission.microphone.status;

  static Future<PermissionStatus> _requestMicrophoneStatus() => Permission.microphone.request();
}
