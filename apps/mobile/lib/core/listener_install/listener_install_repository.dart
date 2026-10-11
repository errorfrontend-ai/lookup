import 'dart:async';

import '../error_reporting/development_log.dart';
import '../identifiers/random_uuid.dart';
import '../network/api_answer.dart';
import '../time/clock.dart';
import 'listener_install_credentials.dart';
import 'listener_install_registration.dart';
import 'listener_install_registration_result.dart';
import 'listener_install_store.dart';

export 'listener_install_credentials.dart';
export 'listener_install_registration_result.dart';

/// The app's listener install (design §3.9, S4-D14): when to register and which token to send.
///
/// - The install id is made once, on first launch, and kept for good.
/// - It registers in the background on first launch, and again only when the token is missing,
///   within 24 hours of its expiry, refused by the API (401) (S4-INSTALLS-02), or registered with
///   another app version than the one running (contract §1.1; P6 design §3.12). An install a Step 4
///   app registered has no version stored, so it registers once more after the update.
/// - After a version change nothing is sent with the old token: when the registration gets no
///   answer, the caller gets that failure, not the old token, so a clip is kept for later.
/// - A re-registration carries the install's own token while it is inside its stored lifetime, as
///   `Authorization: Bearer` (amendment A3); a first registration, and one after a 401, carry none.
/// - One registration at a time: every caller during one shares it, so a fast first tap cannot
///   register twice and two 401s cannot register twice.
/// - The phone's clock can be wrong. A token received from the API during this run is used until
///   the API refuses it, so a phone whose clock is far ahead does not register before every
///   identify; the 401 is the real signal.
/// - Storage failures never stop an identify: the values are kept in memory for this run.
///
/// Nothing here reads a hardware, Android, advertising or IMEI id.
class ListenerInstallRepository {
  /// [clock] and [developmentLog] are for tests and development builds.
  ListenerInstallRepository({
    required ListenerInstallStore store,
    required ListenerInstallRegistration registration,
    required RandomUuid randomUuid,
    Clock? clock,
    DevelopmentLog developmentLog = const DevelopmentLog.off(),
  }) : _store = store,
       _registration = registration,
       _randomUuid = randomUuid,
       _clock = clock ?? Clock(),
       _developmentLog = developmentLog;

  final ListenerInstallStore _store;
  final ListenerInstallRegistration _registration;
  final RandomUuid _randomUuid;
  final Clock _clock;
  final DevelopmentLog _developmentLog;

  /// The install as known in this run, once read.
  ListenerInstallCredentials? _credentials;

  /// Whether [_credentials]' token came from the API during this run.
  bool _isTokenFromThisRun = false;

  /// The check or registration in progress, which every caller shares.
  Future<ListenerInstallRegistrationResult>? _inProgress;

  /// Makes sure the install is registered, without waiting: called after the first frame of every
  /// launch, so the first launch registers before the listener's first tap and later launches do
  /// nothing unless the token is due for renewal.
  void registerInBackground() => unawaited(ensureRegistered());

  /// A token to send, registering first when there is none or it is due for renewal. When a
  /// renewal fails while the old token is still inside its lifetime, the old token is given. Never
  /// throws.
  Future<ListenerInstallRegistrationResult> ensureRegistered() =>
      _shareOne(() => _registerIfNeeded(refusedToken: null));

  /// A new token after the API refused [refusedToken] (401 `INSTALL_TOKEN_INVALID`), registering
  /// again with the same install id. When another caller has already replaced that token, its
  /// replacement is given without a second registration. Never throws.
  Future<ListenerInstallRegistrationResult> registerAgainAfterRefusal({
    required String refusedToken,
  }) async {
    final inProgress = _inProgress;
    if (inProgress != null) await inProgress;
    return _shareOne(() => _registerIfNeeded(refusedToken: refusedToken));
  }

  /// The install id and token known now, for scrubbing them out of crash reports; null when
  /// nothing could be read. Never registers, never makes an install id, never throws.
  Future<ListenerInstallCredentials?> readKnownCredentials() async {
    final known = _credentials;
    if (known != null) return known;
    try {
      return await _store.read();
    } on Object {
      return null;
    }
  }

  Future<ListenerInstallRegistrationResult> _shareOne(
    Future<ListenerInstallRegistrationResult> Function() operation,
  ) {
    final inProgress = _inProgress;
    if (inProgress != null) return inProgress;
    final started = _runThenRelease(operation);
    _inProgress = started;
    return started;
  }

  /// Runs [operation] and clears [_inProgress] before its result is delivered, so a caller that
  /// waited for it and then asks again starts a new check instead of joining the finished one.
  Future<ListenerInstallRegistrationResult> _runThenRelease(
    Future<ListenerInstallRegistrationResult> Function() operation,
  ) async {
    try {
      return await operation();
    } on Object catch (error, stackTrace) {
      // Nothing below is expected to throw; if a fault does, the caller still gets a result.
      _developmentLog.recordEvent(
        'listener install check failed',
        detail: error.runtimeType.toString(),
        stackTrace: stackTrace,
      );
      // A fault on the phone, not the network: the identify shows the phone failure and reports
      // the fault's type, never its text (§3.11).
      return ListenerInstallNotRegistered(
        answer: ApiAnswerNotReceived(
          sentRequestId: _randomUuid.generate(),
          reason: ApiNoAnswerReason.unexpectedFailure,
          faultTypeName: error.runtimeType.toString(),
        ),
      );
    } finally {
      _inProgress = null;
    }
  }

  Future<ListenerInstallRegistrationResult> _registerIfNeeded({
    required String? refusedToken,
  }) async {
    final credentials = await _loadCredentials();
    final now = _clock.now();
    final installToken = credentials.installToken;
    final isTokenRefused = refusedToken != null && installToken == refusedToken;
    final isRegisteredWithThisVersion = credentials.isRegisteredWith(_registration.appVersion);
    if (installToken != null &&
        !isTokenRefused &&
        isRegisteredWithThisVersion &&
        (_isTokenFromThisRun || !credentials.needsRegistrationAt(now))) {
      return ListenerInstallRegistered(credentials);
    }

    if (isTokenRefused) {
      // Forget it first, so it is never sent again even if the app stops before registering.
      _credentials = credentials.withoutToken();
      _isTokenFromThisRun = false;
      await _storeQuietly('forget the refused token', _store.forgetToken);
    }

    final beforeRegistering = _credentials!;
    // The install's own token, while inside its lifetime by the phone's clock (amendment A3). A
    // refused token was forgotten above, so a registration after a 401 carries none.
    final reRegistrationToken = beforeRegistering.hasUnexpiredTokenAt(now)
        ? beforeRegistering.installToken
        : null;
    final result = await _registration.register(
      beforeRegistering,
      reRegistrationToken: reRegistrationToken,
    );
    switch (result) {
      case ListenerInstallRegistered(credentials: final registered):
        _credentials = registered;
        _isTokenFromThisRun = true;
        await _storeQuietly(
          'store the new token',
          () => _store.saveRegistration(
            installToken: registered.installToken!,
            expiresAt: registered.tokenExpiresAt!,
            appVersion: registered.registeredAppVersion!,
          ),
        );
        return result;
      case ListenerInstallNotRegistered():
        // A renewal that failed may keep a token still in date; a version change may not, because
        // nothing is sent with the old token in between (contract §1.1).
        if (!isTokenRefused &&
            isRegisteredWithThisVersion &&
            beforeRegistering.hasUnexpiredTokenAt(now)) {
          return ListenerInstallRegistered(beforeRegistering);
        }
        return result;
    }
  }

  /// The install as stored, made on first launch. When storage cannot be read, an install id for
  /// this run only, so the listener can still identify; the API then sees a new install at each
  /// such launch, which its per-address limit allows for.
  Future<ListenerInstallCredentials> _loadCredentials() async {
    final known = _credentials;
    if (known != null) return known;
    ListenerInstallCredentials loaded;
    try {
      loaded = await _store.readOrCreate();
    } on Object catch (error) {
      _developmentLog.recordEvent(
        'listener install could not be read',
        detail: error.runtimeType.toString(),
      );
      loaded = ListenerInstallCredentials(installId: _randomUuid.generate());
    }
    return _credentials = loaded;
  }

  Future<void> _storeQuietly(String what, Future<void> Function() write) async {
    try {
      await write();
    } on Object catch (error) {
      // The value is kept in memory for this run; the next launch registers again if needed.
      _developmentLog.recordEvent(
        'listener install could not $what',
        detail: error.runtimeType.toString(),
      );
    }
  }
}
