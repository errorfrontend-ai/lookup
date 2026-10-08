import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/widgets.dart' show AppLifecycleListener, AppLifecycleState, WidgetsBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/error_reporting/client_error_report_outcome.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder_provider.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission_provider.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_problem_report.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';

/// The identify state machine of §2.12 (S4-D4): every transition T1 to T41, over the sealed
/// [RecognitionState].
///
/// Screens read the state and call the methods below; the router follows the state (S4-D5).
/// Only Home accepts a new identify (T41). The clip is held here, privately, never in a state, and
/// is dropped on every outcome and every way out except Busy and "No connection", which keep it so
/// the same clip, with the same idempotency key, can be sent again (S4-D7).
///
/// Everything it uses comes from providers, so tests run it with a fake recorder, permission, HTTP
/// adapter, clock and fake time. After every wait it checks that the identify it belongs to is
/// still the current one and the provider is still alive before it changes the state.
class RecognitionFlow extends Notifier<RecognitionState> {
  /// The clip every identify records: 8 seconds of AAC-LC (S4-LISTENING-03).
  static const ClipSettings clipSettings = ClipSettings.standard;

  late ClipRecorder _clipRecorder;
  late MicrophonePermission _microphonePermission;
  late RecognitionRepository _recognitionRepository;
  late Clock _clock;
  late RandomUuid _randomUuid;
  AppLifecycleListener? _lifecycleListener;

  /// Moves on with every new identify and every way out, so a late answer, timer or recorder
  /// event from an earlier one changes nothing.
  int _identifyNumber = 0;

  /// The clip in memory, kept only while Identifying, Busy or "No connection" (S4-D7).
  CapturedClip? _clip;

  /// The counts for [_clip] so far; a fresh policy for every capture.
  SendPolicy _sendPolicy = const SendPolicy();

  ClipRecording? _recording;
  StreamSubscription<double>? _levelSubscription;
  StreamSubscription<void>? _interruptionSubscription;
  Timer? _recordingCountdown;
  Timer? _busyCountdown;
  Timer? _inProgressWait;
  RecognitionCancellation? _sendCancellation;

  /// Whether the app is on screen: resumed, or inactive (the notification shade over it), which
  /// changes nothing (S4-D23).
  bool _isInForeground = true;

  /// Set while a tap's permission check is under way, before the state shows it, so a double tap
  /// starts one identify only (T41).
  bool _isStartingCapture = false;

  /// Set while the system prompt is open, so coming back from it is not mistaken for coming back
  /// from the phone's settings (T7).
  bool _isRequestingAccess = false;

  bool _isCheckingAccessOnReturn = false;

  @override
  RecognitionState build() {
    _clipRecorder = ref.watch(clipRecorderProvider);
    _microphonePermission = ref.watch(microphonePermissionProvider);
    _recognitionRepository = ref.watch(recognitionRepositoryProvider);
    _clock = ref.watch(recognitionClockProvider);
    _randomUuid = ref.watch(recognitionRandomUuidProvider);
    _isInForeground = _isForeground(WidgetsBinding.instance.lifecycleState);
    _lifecycleListener = AppLifecycleListener(onStateChange: _followLifecycle);
    ref.onDispose(_endEverything);
    // A crash between stopping a recording and deleting its file leaves a clip behind (S4-D7).
    _deleteLeftoverClips();
    return const IdleState();
  }

  /// Whether a clip is in memory now. For tests of the clip's lifetime; no screen needs it.
  @visibleForTesting
  bool get hasKeptClip => _clip != null;

  /// Home's "Tap to identify" (T1, T2): records at once when the microphone is allowed, otherwise
  /// shows the Permission screen, reading the status only (no system prompt). Ignored anywhere but
  /// Home and while a tap is already being handled (T41).
  Future<void> identify() async {
    if (state is! IdleState) return;
    await _startCapture();
  }

  /// "Try again" on No match and on the server-failure, phone-failure and recording-unusable
  /// errors (T36): a new capture with a new idempotency key, the permission checked first.
  Future<void> tryAgain() async {
    final mayTryAgain = switch (state) {
      NoMatchState() => true,
      ErrorState(failure: ServerFailure() || PhoneFailure() || RecordingUnusableFailure()) => true,
      _ => false,
    };
    if (!mayTryAgain) return;
    await _startCapture();
  }

  /// "Allow microphone" on the Permission screen (T3 to T5): the only place the system prompt is
  /// shown. Allowed → Listening; refused → the screen's refused-once or refused-for-good variant.
  /// When the system will no longer ask, the screen's primary button opens the phone's settings
  /// instead, and so does this.
  Future<void> allowMicrophone() async {
    final current = state;
    if (current is! PermissionNeededState || _isRequestingAccess) return;
    if (current.microphoneAccess == MicrophoneAccess.refusedForGood) {
      await openPhoneSettings();
      return;
    }
    _isRequestingAccess = true;
    final identifyNumber = _beginIdentify();
    try {
      final access = await _microphonePermission.requestAccess();
      if (!_isCurrent(identifyNumber)) return;
      switch (access) {
        case MicrophoneAccess.granted:
          await _startRecording(identifyNumber);
        case MicrophoneAccess.refusedForGood:
          state = const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedForGood);
        case MicrophoneAccess.refusedOnce || MicrophoneAccess.notAskedYet:
          state = const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedOnce);
      }
    } on Object catch (error, stackTrace) {
      _failOnPhone(
        identifyNumber,
        error,
        stackTrace,
        description: 'Asking for the microphone failed',
      );
    } finally {
      _isRequestingAccess = false;
    }
  }

  /// "Open phone settings" on the Permission screen, the footer link or the refused-for-good
  /// primary button (T6): opens Look Up's page in the phone's settings; the state stays. Coming
  /// back with the microphone allowed leads Home (T7).
  Future<void> openPhoneSettings() async {
    if (state is! PermissionNeededState) return;
    try {
      await _microphonePermission.openSettings();
    } on Object catch (error, stackTrace) {
      _reportQuietly(error, stackTrace, description: 'Opening the phone settings failed');
    }
  }

  /// "Try now" on Busy (T32): stops the countdown and sends the kept clip at once. It counts as a
  /// send of the clip like the automatic one (S4-D11).
  Future<void> tryNow() async {
    if (state is! BusyState || _clip == null) return;
    await _send(_beginIdentify());
  }

  /// "Send again" on "No connection" (T37): the kept clip, with the same idempotency key, so the
  /// API answers with a replay if the first send reached it.
  Future<void> sendAgain() async {
    if (state case ErrorState(failure: ConnectionFailure()) when _clip != null) {
      await _send(_beginIdentify());
    }
  }

  /// Every way back to Home: Back and "Not now" on Permission (T8), Close ×, Cancel and system
  /// back on Listening (T12), Identifying (T28) and Busy (T33), Back on Result (T35), Close × and
  /// "Back to home" on No match and Error (T38). Whatever is under way stops: the recorder is
  /// cancelled and its file deleted, a send is cancelled, the countdown stops, and the clip is
  /// dropped. Nothing is sent. Ignored on Home itself.
  void backToHome() {
    if (state is IdleState) return;
    _goHome();
  }

  Future<void> _startCapture() async {
    if (_isStartingCapture) return;
    _isStartingCapture = true;
    final identifyNumber = _beginIdentify();
    _dropClip();
    try {
      final access = await _microphonePermission.readAccess();
      if (!_isCurrent(identifyNumber)) return;
      if (access == MicrophoneAccess.granted) {
        await _startRecording(identifyNumber);
      } else {
        state = PermissionNeededState(microphoneAccess: access);
      }
    } on Object catch (error, stackTrace) {
      _failOnPhone(
        identifyNumber,
        error,
        stackTrace,
        description: 'Reading the microphone permission failed',
      );
    } finally {
      _isStartingCapture = false;
    }
  }

  /// T1 and T3: makes the idempotency key, opens the microphone, takes the capture time and starts
  /// the countdown. Never while the app is in the background: recording only ever follows a tap on
  /// a screen the listener can see (S4-D23).
  Future<void> _startRecording(int identifyNumber) async {
    if (!_isInForeground) {
      _goHome();
      return;
    }
    final idempotencyKey = _randomUuid.generate();
    state = RecordingState(levelFraction: 0, secondsLeft: clipSettings.clipDurationSeconds);
    final ClipRecording recording;
    try {
      recording = await _clipRecorder.start(idempotencyKey: idempotencyKey, settings: clipSettings);
    } on Object catch (error, stackTrace) {
      _failOnPhone(identifyNumber, error, stackTrace, description: 'The recorder could not start');
      return;
    }
    if (!_isCurrent(identifyNumber)) {
      // Cancelled while the microphone was opening: release it and delete the file at once.
      unawaited(recording.cancel());
      return;
    }
    final capturedAt = _clock.now();
    _recording = recording;
    _levelSubscription = recording.levelFractions.listen(
      (levelFraction) => _showLevel(identifyNumber, levelFraction),
      onError: (Object error) {},
    );
    _interruptionSubscription = recording.interruptions.listen(
      (_) => _cancelInterruptedRecording(identifyNumber),
      onError: (Object error) {},
    );
    _recordingCountdown = Timer.periodic(
      const Duration(seconds: 1),
      (countdown) => _countDownRecording(identifyNumber, countdown, idempotencyKey, capturedAt),
    );
  }

  /// T9: a new level, the same seconds left.
  void _showLevel(int identifyNumber, double levelFraction) {
    if (!_isCurrent(identifyNumber)) return;
    if (state case RecordingState(:final secondsLeft)) {
      state = RecordingState(
        levelFraction: levelFraction.isNaN ? 0 : levelFraction.clamp(0, 1).toDouble(),
        secondsLeft: secondsLeft,
      );
    }
  }

  /// T10 and T11: one second less each tick; at the clip's length the recording is finished. The
  /// timer's tick count follows the monotonic clock, so a late tick never stretches the clip.
  void _countDownRecording(
    int identifyNumber,
    Timer countdown,
    String idempotencyKey,
    DateTime capturedAt,
  ) {
    final current = state;
    if (!_isCurrent(identifyNumber) || current is! RecordingState) {
      countdown.cancel();
      return;
    }
    final secondsLeft = clipSettings.clipDurationSeconds - countdown.tick;
    state = RecordingState(
      levelFraction: current.levelFraction,
      secondsLeft: secondsLeft < 0 ? 0 : secondsLeft,
    );
    if (secondsLeft > 0) return;
    countdown.cancel();
    _recordingCountdown = null;
    unawaited(_finishRecording(identifyNumber, idempotencyKey, capturedAt));
  }

  /// T13, from the recorder: a call or another app paused it, so the clip is cancelled.
  void _cancelInterruptedRecording(int identifyNumber) {
    if (_isCurrent(identifyNumber) && state is RecordingState) _goHome();
  }

  /// T11: stops the recorder, reads the clip into memory (the recorder deletes the file at once)
  /// and sends it; T14 when there is no usable clip.
  Future<void> _finishRecording(
    int identifyNumber,
    String idempotencyKey,
    DateTime capturedAt,
  ) async {
    final recording = _recording;
    if (recording == null) return;
    _recording = null;
    _stopListeningToRecording();
    final List<int> audioBytes;
    try {
      audioBytes = await recording.finish();
    } on Object catch (error, stackTrace) {
      _failOnPhone(
        identifyNumber,
        error,
        stackTrace,
        description: 'The recorder could not finish the clip',
      );
      return;
    }
    if (!_isCurrent(identifyNumber)) return;
    _clip = CapturedClip(
      audioBytes: audioBytes,
      idempotencyKey: idempotencyKey,
      capturedAt: capturedAt,
      settings: clipSettings,
    );
    _sendPolicy = const SendPolicy();
    await _send(identifyNumber);
  }

  /// One send of the kept clip (T15 to T27), and what `SendPolicy` makes of its answer.
  Future<void> _send(int identifyNumber, {bool registersAgainFirst = false}) async {
    final clip = _clip;
    if (clip == null || !_isCurrent(identifyNumber)) return;
    state = const UploadingState();
    final cancellation = RecognitionCancellation();
    _sendCancellation = cancellation;
    final RecognitionAnswer answer;
    try {
      answer = await _recognitionRepository.send(
        clip,
        cancellation: cancellation,
        registersAgainFirst: registersAgainFirst,
      );
    } on Object catch (error, stackTrace) {
      _failOnPhone(
        identifyNumber,
        error,
        stackTrace,
        description: 'Sending the clip failed on the phone',
      );
      return;
    }
    if (!_isCurrent(identifyNumber)) return;
    _sendCancellation = null;
    final outcome = _sendPolicy.decide(answer, reportRequestId: _randomUuid.generate());
    await _follow(identifyNumber, outcome);
  }

  Future<void> _follow(int identifyNumber, RecognitionOutcome outcome) async {
    if (!outcome.isClipKept) _dropClip();
    switch (outcome) {
      case FinishedOutcome(:final nextState, :final problemReport):
        // Matched, fallback, no match, or an error other than "no connection" (T16 to T19, T21,
        // T24 to T26); the Result screen gives its own haptic tick on entering.
        if (nextState is IdleState) {
          _goHome();
          return;
        }
        state = nextState;
        if (problemReport != null) {
          unawaited(_sendProblemReport(identifyNumber, problemReport, shownState: nextState));
        }
      case ConnectionLostOutcome(:final nextState):
        // T27: the clip and its counts stay for "Send again".
        state = nextState;
      case BusyOutcome(:final nextState, :final nextPolicy):
        // T20: the clip stays; the countdown sends it again.
        _sendPolicy = nextPolicy;
        state = nextState;
        _startBusyCountdown(identifyNumber);
      case WaitAndResendOutcome(:final waitSeconds, :final nextPolicy):
        // T22: still on Identifying; the same clip and key after the wait.
        _sendPolicy = nextPolicy;
        _inProgressWait = Timer(Duration(seconds: waitSeconds), () {
          _inProgressWait = null;
          unawaited(_send(identifyNumber));
        });
      case RegisterAgainOutcome(:final nextPolicy):
        // T23: still on Identifying; a new token for the same install, then the same clip again.
        _sendPolicy = nextPolicy;
        await _send(identifyNumber, registersAgainFirst: true);
    }
  }

  /// T29 to T31: counts the Busy wait down, one second at a time, only while the app is in the
  /// foreground; at zero the kept clip is sent again with a new request id and send time.
  void _startBusyCountdown(int identifyNumber) {
    _busyCountdown?.cancel();
    _busyCountdown = null;
    if (!_isInForeground) return;
    _busyCountdown = Timer.periodic(
      const Duration(seconds: 1),
      (countdown) => _countDownBusy(identifyNumber, countdown),
    );
  }

  void _countDownBusy(int identifyNumber, Timer countdown) {
    final current = state;
    if (!_isCurrent(identifyNumber) || current is! BusyState) {
      countdown.cancel();
      return;
    }
    if (current.secondsUntilRetry > 1) {
      state = BusyState(
        retryDelaySeconds: current.retryDelaySeconds,
        secondsUntilRetry: current.secondsUntilRetry - 1,
      );
      return;
    }
    countdown.cancel();
    _busyCountdown = null;
    unawaited(_send(identifyNumber));
  }

  /// The crash report the policy asked for. When the failure shown is a phone failure, its code
  /// appears only once the API has accepted the report (T39).
  Future<void> _sendProblemReport(
    int identifyNumber,
    RecognitionProblemReport problemReport, {
    required RecognitionState shownState,
  }) async {
    final delivery = await _recognitionRepository.reportAnswerProblem(
      problemReport,
      location: _routePathOf(const UploadingState()),
    );
    _settleReportDelivery(identifyNumber, shownState, delivery);
  }

  /// T14 and every unexpected error in the flow: stop everything, drop the clip, show the phone
  /// failure and report it.
  void _failOnPhone(
    int identifyNumber,
    Object error,
    StackTrace stackTrace, {
    required String description,
  }) {
    if (!_isCurrent(identifyNumber)) return;
    final location = _routePathOf(state);
    _stopActivities();
    _dropClip();
    final reportRequestId = _randomUuid.generate();
    final shownState = ErrorState(
      failure: PhoneFailure(
        reportRequestId: reportRequestId,
        reportDelivery: ReportDelivery.sending,
      ),
    );
    state = shownState;
    unawaited(
      _recognitionRepository
          .reportPhoneFailure(
            error: error,
            stackTrace: stackTrace,
            description: description,
            reportRequestId: reportRequestId,
            location: location,
          )
          .then(
            (delivery) => _settleReportDelivery(identifyNumber, shownState, delivery),
            // The reporter never fails; if it did, the failure simply shows no code.
            onError: (Object error) {},
          ),
    );
  }

  /// T39: the phone failure's report was answered. The code it shows is the id the API logged the
  /// report under, so support can find it.
  void _settleReportDelivery(
    int identifyNumber,
    RecognitionState shownState,
    ClientErrorReportOutcome delivery,
  ) {
    if (!_isCurrent(identifyNumber) || state != shownState) return;
    if (shownState case ErrorState(failure: PhoneFailure(:final reportRequestId))) {
      state = ErrorState(
        failure: switch (delivery) {
          ClientErrorReportAccepted(reportRequestId: final acceptedRequestId) => PhoneFailure(
            reportRequestId: acceptedRequestId,
            reportDelivery: ReportDelivery.accepted,
          ),
          ClientErrorReportNotAccepted() || ClientErrorReportHeldBack() => PhoneFailure(
            reportRequestId: reportRequestId,
            reportDelivery: ReportDelivery.notAccepted,
          ),
        },
      );
    }
  }

  /// Reports a failure that does not change the screen (opening the settings, re-checking the
  /// permission on return). Never throws.
  void _reportQuietly(Object error, StackTrace stackTrace, {required String description}) {
    final location = _routePathOf(state);
    unawaited(
      _recognitionRepository
          .reportPhoneFailure(
            error: error,
            stackTrace: stackTrace,
            description: description,
            reportRequestId: _randomUuid.generate(),
            location: location,
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }

  /// The app's lifecycle (§3.17, S4-D23): hidden or paused cancels a recording (T13) and pauses
  /// Busy's countdown (T31); shown again resumes it; resumed on the Permission screen re-reads the
  /// permission (T7). `inactive` alone changes nothing.
  void _followLifecycle(AppLifecycleState lifecycleState) {
    final wasInForeground = _isInForeground;
    _isInForeground = _isForeground(lifecycleState);
    final current = state;
    if (!_isInForeground) {
      if (current is RecordingState) _goHome();
      if (current is BusyState) {
        _busyCountdown?.cancel();
        _busyCountdown = null;
      }
      return;
    }
    if (!wasInForeground && current is BusyState) _startBusyCountdown(_identifyNumber);
    if (lifecycleState == AppLifecycleState.resumed && current is PermissionNeededState) {
      unawaited(_checkAccessOnReturn());
    }
  }

  /// T7: back from the phone's settings with the microphone now allowed → Home, where nothing is
  /// recorded until the next tap. Still refused → the screen stays.
  Future<void> _checkAccessOnReturn() async {
    if (_isRequestingAccess || _isCheckingAccessOnReturn) return;
    _isCheckingAccessOnReturn = true;
    final identifyNumber = _identifyNumber;
    try {
      final access = await _microphonePermission.readAccess();
      if (_isCurrent(identifyNumber) &&
          state is PermissionNeededState &&
          access == MicrophoneAccess.granted) {
        _goHome();
      }
    } on Object catch (error, stackTrace) {
      _reportQuietly(
        error,
        stackTrace,
        description: 'Reading the microphone permission on return failed',
      );
    } finally {
      _isCheckingAccessOnReturn = false;
    }
  }

  /// Home, with nothing left over: everything under way stopped, the clip dropped, and any clip
  /// file an earlier run left behind deleted.
  void _goHome() {
    _beginIdentify();
    _dropClip();
    state = const IdleState();
    _deleteLeftoverClips();
  }

  /// Ends whatever the previous identify was doing and gives the new one its number.
  int _beginIdentify() {
    _stopActivities();
    return ++_identifyNumber;
  }

  /// Stops the recorder (its file deleted), the countdowns, the 409 wait and the send under way.
  void _stopActivities() {
    _recordingCountdown?.cancel();
    _recordingCountdown = null;
    _busyCountdown?.cancel();
    _busyCountdown = null;
    _inProgressWait?.cancel();
    _inProgressWait = null;
    _sendCancellation?.cancel();
    _sendCancellation = null;
    _stopListeningToRecording();
    final recording = _recording;
    _recording = null;
    if (recording != null) unawaited(recording.cancel());
  }

  void _stopListeningToRecording() {
    unawaited(_levelSubscription?.cancel());
    _levelSubscription = null;
    unawaited(_interruptionSubscription?.cancel());
    _interruptionSubscription = null;
  }

  void _dropClip() {
    _clip = null;
    _sendPolicy = const SendPolicy();
  }

  void _deleteLeftoverClips() {
    unawaited(_clipRecorder.deleteLeftoverClips().then<void>((_) {}, onError: (Object error) {}));
  }

  void _endEverything() {
    _identifyNumber++;
    _stopActivities();
    _dropClip();
    _lifecycleListener?.dispose();
    _lifecycleListener = null;
  }

  /// The route path a state is shown at (§3.6), for a crash report's `location`: where the failure
  /// happened, e.g. `/listening` when the recorder failed.
  static String _routePathOf(RecognitionState state) => switch (state) {
    IdleState() => '/',
    PermissionNeededState() => '/permission',
    RecordingState() => '/listening',
    UploadingState() => '/identifying',
    MatchedState() || FallbackState() => '/result',
    NoMatchState() => '/no-match',
    BusyState() => '/busy',
    ErrorState() => '/error',
  };

  bool _isCurrent(int identifyNumber) => ref.mounted && identifyNumber == _identifyNumber;

  static bool _isForeground(AppLifecycleState? lifecycleState) => switch (lifecycleState) {
    null || AppLifecycleState.resumed || AppLifecycleState.inactive => true,
    AppLifecycleState.hidden || AppLifecycleState.paused || AppLifecycleState.detached => false,
  };
}

/// The identify state machine; kept alive for the app's life, so the clip and the countdowns
/// survive screen changes (design §3.5).
final NotifierProvider<RecognitionFlow, RecognitionState> recognitionFlowProvider =
    NotifierProvider<RecognitionFlow, RecognitionState>(
      RecognitionFlow.new,
      // Never rebuilt on its own after a failure: that could resend a clip silently (S4-D4).
      retry: (retryCount, error) => null,
    );

/// The wall clock the flow takes capture times from. The real clock in the app; tests override it.
final Provider<Clock> recognitionClockProvider = Provider<Clock>(
  (ref) => Clock(),
  retry: (retryCount, error) => null,
);

/// Where the flow's idempotency keys and crash-report ids come from: `Random.secure()` in the app;
/// tests override it.
final Provider<RandomUuid> recognitionRandomUuidProvider = Provider<RandomUuid>(
  (ref) => RandomUuid(),
  retry: (retryCount, error) => null,
);
