import 'package:shared_preferences/shared_preferences.dart';

import '../identifiers/random_uuid.dart';
import 'listener_install_credentials.dart';

/// Keeps the install id, the install token, its expiry and the app version the install registered
/// with in `shared_preferences`, which is app-private storage; Android backup is off, so neither
/// the id nor the token is copied to another phone (design §3.9, S4-D14, gap 12; P6 design §3.12).
///
/// Two Dart engines can share these values (the app's, and a background job's), and each keeps its
/// own cached copy of `SharedPreferences`. So every read and every write starts with `reload()`:
/// a token one engine stored is the token the other reads next (P6-D45), and a refused token is
/// removed only while it is still the stored one.
///
/// It uses the package's `SharedPreferences` class rather than the `SharedPreferencesAsync` the
/// design names, because only `SharedPreferences` can be replaced in tests through the package's
/// own `setMockInitialValues`: the async class's test double lives in a package the app does not
/// depend on. Both keep the values in the same app-private place.
///
/// A failure to read or write is thrown to the caller, the repository, which decides what to do.
class ListenerInstallStore {
  /// [openPreferences] is for tests; the app uses `SharedPreferences.getInstance`.
  ListenerInstallStore({
    required RandomUuid randomUuid,
    Future<SharedPreferences> Function()? openPreferences,
  }) : _randomUuid = randomUuid,
       _openPreferences = openPreferences ?? SharedPreferences.getInstance;

  /// The storage keys, exactly as the design names them.
  static const String installIdKey = 'listener_install_id';
  static const String installTokenKey = 'listener_install_token';
  static const String tokenExpiresAtKey = 'listener_install_token_expires_at';
  static const String registeredAppVersionKey = 'listener_install_registered_app_version';

  /// A UUID of any version, the shape the API's contract accepts as an install id.
  static final RegExp _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  final RandomUuid _randomUuid;
  final Future<SharedPreferences> Function() _openPreferences;

  /// What is stored, or null when no install id was made yet. Never creates one, so the crash
  /// reporter can read the secrets to scrub without starting an install.
  Future<ListenerInstallCredentials?> read() async {
    final preferences = await _openFresh();
    final installId = preferences.getString(installIdKey);
    if (installId == null || !_uuid.hasMatch(installId)) return null;
    return _credentialsFor(installId, preferences);
  }

  /// What is stored, making and storing the install id first when there is none: on first launch,
  /// or when the stored one is not a UUID the API would accept (which would otherwise be refused
  /// for ever). A readable install id is never replaced.
  Future<ListenerInstallCredentials> readOrCreate() async {
    final preferences = await _openFresh();
    final storedInstallId = preferences.getString(installIdKey);
    if (storedInstallId != null && _uuid.hasMatch(storedInstallId)) {
      return _credentialsFor(storedInstallId, preferences);
    }
    final installId = _randomUuid.generate();
    _checkWritten(await preferences.setString(installIdKey, installId));
    // A token and a version left from an id that was unreadable belong to another install.
    await _removeToken(preferences);
    _checkWritten(await preferences.remove(registeredAppVersionKey));
    return ListenerInstallCredentials(installId: installId);
  }

  /// Stores a registration the API accepted: its token, the expiry in UTC, and the app version it
  /// was registered with.
  Future<void> saveRegistration({
    required String installToken,
    required DateTime expiresAt,
    required String appVersion,
  }) async {
    final preferences = await _openFresh();
    _checkWritten(await preferences.setString(installTokenKey, installToken));
    _checkWritten(
      await preferences.setString(tokenExpiresAtKey, expiresAt.toUtc().toIso8601String()),
    );
    _checkWritten(await preferences.setString(registeredAppVersionKey, appVersion));
  }

  /// Forgets [refusedToken], which the API refused, while it is still the stored token, and gives
  /// true; the install id and its registered version stay. When another engine has stored a new
  /// token since the refused one was read, that token stays and the answer is false (P6-D45).
  Future<bool> forgetToken(String refusedToken) async {
    final preferences = await _openFresh();
    final storedToken = preferences.getString(installTokenKey);
    if (storedToken != null && storedToken.isNotEmpty && storedToken != refusedToken) return false;
    await _removeToken(preferences);
    return true;
  }

  /// The preferences with what any engine wrote since this one last read them.
  Future<SharedPreferences> _openFresh() async {
    final preferences = await _openPreferences();
    await preferences.reload();
    return preferences;
  }

  ListenerInstallCredentials _credentialsFor(String installId, SharedPreferences preferences) {
    final installToken = preferences.getString(installTokenKey);
    final expiresAtText = preferences.getString(tokenExpiresAtKey);
    final expiresAt = expiresAtText == null ? null : DateTime.tryParse(expiresAtText)?.toUtc();
    final storedVersion = preferences.getString(registeredAppVersionKey);
    final registeredAppVersion = storedVersion == null || storedVersion.isEmpty
        ? null
        : storedVersion;
    // A token without a readable expiry is treated as no token: the app registers again.
    if (installToken == null || installToken.isEmpty || expiresAt == null) {
      return ListenerInstallCredentials(
        installId: installId,
        registeredAppVersion: registeredAppVersion,
      );
    }
    return ListenerInstallCredentials(
      installId: installId,
      installToken: installToken,
      tokenExpiresAt: expiresAt,
      registeredAppVersion: registeredAppVersion,
    );
  }

  Future<void> _removeToken(SharedPreferences preferences) async {
    _checkWritten(await preferences.remove(installTokenKey));
    _checkWritten(await preferences.remove(tokenExpiresAtKey));
  }

  static void _checkWritten(bool isWritten) {
    if (!isWritten) throw StateError('The listener install could not be stored.');
  }
}
