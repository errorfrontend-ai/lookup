import 'package:shared_preferences/shared_preferences.dart';

import '../identifiers/random_uuid.dart';
import 'listener_install_credentials.dart';

/// Keeps the install id, the install token and its expiry in `shared_preferences`, which is
/// app-private storage; Android backup is off, so neither the id nor the token is copied to another
/// phone (design §3.9, S4-D14, gap 12).
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

  /// A UUID of any version, the shape the API's contract accepts as an install id.
  static final RegExp _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  final RandomUuid _randomUuid;
  final Future<SharedPreferences> Function() _openPreferences;

  /// What is stored, or null when no install id was made yet. Never creates one, so the crash
  /// reporter can read the secrets to scrub without starting an install.
  Future<ListenerInstallCredentials?> read() async {
    final preferences = await _openPreferences();
    final installId = preferences.getString(installIdKey);
    if (installId == null || !_uuid.hasMatch(installId)) return null;
    return _credentialsFor(installId, preferences);
  }

  /// What is stored, making and storing the install id first when there is none: on first launch,
  /// or when the stored one is not a UUID the API would accept (which would otherwise be refused
  /// for ever). A readable install id is never replaced.
  Future<ListenerInstallCredentials> readOrCreate() async {
    final preferences = await _openPreferences();
    final storedInstallId = preferences.getString(installIdKey);
    if (storedInstallId != null && _uuid.hasMatch(storedInstallId)) {
      return _credentialsFor(storedInstallId, preferences);
    }
    final installId = _randomUuid.generate();
    _checkWritten(await preferences.setString(installIdKey, installId));
    // A token left from an id that was unreadable belongs to another install.
    await _removeToken(preferences);
    return ListenerInstallCredentials(installId: installId);
  }

  /// Stores a token the API gave, with its expiry in UTC.
  Future<void> saveToken({required String installToken, required DateTime expiresAt}) async {
    final preferences = await _openPreferences();
    _checkWritten(await preferences.setString(installTokenKey, installToken));
    _checkWritten(
      await preferences.setString(tokenExpiresAtKey, expiresAt.toUtc().toIso8601String()),
    );
  }

  /// Forgets the token (the API refused it); the install id stays.
  Future<void> forgetToken() async => _removeToken(await _openPreferences());

  ListenerInstallCredentials _credentialsFor(String installId, SharedPreferences preferences) {
    final installToken = preferences.getString(installTokenKey);
    final expiresAtText = preferences.getString(tokenExpiresAtKey);
    final expiresAt = expiresAtText == null ? null : DateTime.tryParse(expiresAtText)?.toUtc();
    // A token without a readable expiry is treated as no token: the app registers again.
    if (installToken == null || installToken.isEmpty || expiresAt == null) {
      return ListenerInstallCredentials(installId: installId);
    }
    return ListenerInstallCredentials(
      installId: installId,
      installToken: installToken,
      tokenExpiresAt: expiresAt,
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
