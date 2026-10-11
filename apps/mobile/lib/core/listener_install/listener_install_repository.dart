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
/// - Two engines share the stored values: the app's, and a background job's (P6 design §3.10).
///   Every decision starts by reading the store again, which reloads, so a token the other engine
///   stored is the one used next, with no registration of its own (P6-D45). A refused token is
///   forgotten only while it is still the stored one, so another engine's newer token stays.
/// - Storage failures never stop an identify: when the store cannot be read, this run's own copy
///   of the values is used instead.
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

  /// The install as this run last read or registered it: the copy used when the store cannot be
  /// read.
  ListenerInstallCredentials? _credentials;

  /// The token the API gave this run, if any. Used until refused, whatever the phone's clock says,
  /// but only while it is the token in use: a token another engine stored is judged by the clock.
  String? _tokenFromThisRun;

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
  /// again with the same install id. When another caller, or another engine, has already replaced
  /// that token, its replacement is given without a second registration. Never throws.
  Future<ListenerInstallRegistrationResult> registerAgainAfterRefusal({
    required String refusedToken,
  }) async {
    final inProgress = _inProgress;
    if (inProgress != null) await inProgress;
    return _shareOne(() => _registerIfNeeded(refusedToken: refusedToken));
  }

  /// The install id and token known now, for scrubbing them out of crash reports: as stored, or
  /// this run's own copy when the store cannot be read; null when there is neither. Never
  /// registers, never makes an install id, never throws.
  Future<ListenerInstallCredentials?> readKnownCredentials() async {
    try {
      return await _store.read() ?? _credentials;
    } on Object {
      return _credentials;
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
    var credentials = await _loadCredentials();
    final now = _clock.now();
    if (_canSendAsItIs(credentials, refusedToken: refusedToken, now: now)) {
      return ListenerInstallRegistered(credentials);
    }

    if (refusedToken != null && credentials.installToken == refusedToken) {
      // Forget it first, so it is never sent again even if the app stops before registering.
      credentials = _credentials = credentials.withoutToken();
      if (await _forgetQuietly(refusedToken) == _Forgetting.keptAnotherEnginesToken) {
        // Another engine stored a new token after this one was read: use it, without registering.
        credentials = await _loadCredentials();
        if (_canSendAsItIs(credentials, refusedToken: refusedToken, now: now)) {
          return ListenerInstallRegistered(credentials);
        }
      }
    }

    final beforeRegistering = credentials;
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
        _tokenFromThisRun = registered.installToken;
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
        // A renewal that failed may keep a token still in date; a refused token may not, and
        // neither may a version change, because nothing is sent with the old token in between
        // (contract §1.1).
        if (beforeRegistering.installToken != refusedToken &&
            beforeRegistering.isRegisteredWith(_registration.appVersion) &&
            beforeRegistering.hasUnexpiredTokenAt(now)) {
          return ListenerInstallRegistered(beforeRegistering);
        }
        return result;
    }
  }

  /// Whether [credentials]' token can be sent without registering first: there is one, the API
  /// has not just refused it, it was registered with the version running, and either the API gave
  /// it to this run or the phone's clock says it is not yet due for renewal.
  bool _canSendAsItIs(
    ListenerInstallCredentials credentials, {
    required String? refusedToken,
    required DateTime now,
  }) {
    final installToken = credentials.installToken;
    return installToken != null &&
        installToken != refusedToken &&
        credentials.isRegisteredWith(_registration.appVersion) &&
        (installToken == _tokenFromThisRun || !credentials.needsRegistrationAt(now));
  }

  /// The install as stored now, made on first launch. It is read again before every decision (the
  /// store reloads), so what another engine stored since is what counts (P6-D45). When storage
  /// cannot be read, this run's own copy, or before there is one an install id for this run only,
  /// so the listener can still identify; the API then sees a new install at each such launch,
  /// which its per-address limit allows for.
  Future<ListenerInstallCredentials> _loadCredentials() async {
    try {
      return _credentials = await _store.readOrCreate();
    } on Object catch (error) {
      _developmentLog.recordEvent(
        'listener install could not be read',
        detail: error.runtimeType.toString(),
      );
      return _credentials ??= ListenerInstallCredentials(installId: _randomUuid.generate());
    }
  }

  /// Forgets [refusedToken] in the store while it is still the stored token. When storage fails,
  /// the token is forgotten in memory only, and the registration goes ahead.
  Future<_Forgetting> _forgetQuietly(String refusedToken) async {
    try {
      return await _store.forgetToken(refusedToken)
          ? _Forgetting.forgotten
          : _Forgetting.keptAnotherEnginesToken;
    } on Object catch (error) {
      _developmentLog.recordEvent(
        'listener install could not forget the refused token',
        detail: error.runtimeType.toString(),
      );
      return _Forgetting.failed;
    }
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

/// What became of a refused token in the store.
enum _Forgetting {
  /// It was the stored token, and is gone.
  forgotten,

  /// Another engine had stored a new token since; that one stays.
  keptAnotherEnginesToken,

  /// The store could not be read or written.
  failed,
}
