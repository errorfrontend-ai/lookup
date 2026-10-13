import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/widgets.dart' show AppLifecycleListener, AppLifecycleState, WidgetsBinding;
import 'package:lookup_listener/core/outbox/outbox_sender.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// Starts the outbox's runs (P6 design §3.9 point 1; P6-OFFLINE-07): on app start, on resume, when
/// an item is queued, and — amendment A1 — by itself after a wait. While the app is in the
/// foreground it keeps one timer, set for the time the last run said the next item falls due (the
/// earliest `next_attempt_at`, a group's pause ending, or a 426 probe), so a run starts again
/// without a restart, a resume or a network event: a choice made with no signal is sent soon after
/// the signal returns, sooner after the first failure and less often after each one.
///
/// The timer is cancelled when the app is hidden, and a resume starts a run that sets it again.
/// When Android reports the network back while the app is in the foreground, a run starts at once
/// (its "no answer" waits cleared, §3.9); while it is hidden, the background job sends instead.
class OutboxRunScheduler {
  /// [itemsQueued] fires after each item reaches the outbox (`OutboxStore.itemsQueued`);
  /// [networkBack] when Android reports a network again (`NetworkWatcher.networkBack`).
  OutboxRunScheduler({
    required OutboxSender sender,
    required Stream<void> itemsQueued,
    Stream<void>? networkBack,
    required Clock clock,
  }) : _sender = sender,
       _itemsQueued = itemsQueued,
       _networkBack = networkBack,
       _clock = clock;

  final OutboxSender _sender;
  final Stream<void> _itemsQueued;
  final Stream<void>? _networkBack;
  final Clock _clock;

  AppLifecycleListener? _lifecycleListener;
  StreamSubscription<void>? _itemsQueuedSubscription;
  StreamSubscription<void>? _networkBackSubscription;
  Timer? _wakeUpTimer;
  DateTime? _wakeUpAt;
  bool _isInForeground = true;
  bool _isStarted = false;
  bool _isDisposed = false;

  /// When the next run starts by itself, as the last run said; null when nothing waits. The timer
  /// runs only while the app is in the foreground.
  @visibleForTesting
  DateTime? get wakeUpAt => _wakeUpAt;

  /// Whether the wake-up timer is set now.
  @visibleForTesting
  bool get isWakeUpSet => _wakeUpTimer?.isActive ?? false;

  /// Starts following the app and the outbox, and starts the first run. Called once, after the
  /// app's first frame; a second call does nothing.
  void start() {
    if (_isStarted || _isDisposed) return;
    _isStarted = true;
    _isInForeground = _isForeground(WidgetsBinding.instance.lifecycleState);
    _lifecycleListener = AppLifecycleListener(onStateChange: _followLifecycle);
    _itemsQueuedSubscription = _itemsQueued.listen(
      (_) => unawaited(_startRun(OutboxRunReason.itemQueued)),
    );
    _networkBackSubscription = _networkBack?.listen((_) {
      if (_isInForeground) unawaited(_startRun(OutboxRunReason.networkBack));
    });
    unawaited(_startRun(OutboxRunReason.appStarted));
  }

  /// Starts a run now, with no random wait: the background job asked, while this engine is in the
  /// foreground, so the two engines never send at once (P6 design §3.10).
  void runNow() {
    if (!_isStarted || _isDisposed) return;
    unawaited(_startRun(OutboxRunReason.wakeUp));
  }

  /// Stops everything: the timer, the subscriptions. A run under way finishes on its own.
  void dispose() {
    _isDisposed = true;
    _wakeUpTimer?.cancel();
    _wakeUpTimer = null;
    unawaited(_itemsQueuedSubscription?.cancel());
    _itemsQueuedSubscription = null;
    unawaited(_networkBackSubscription?.cancel());
    _networkBackSubscription = null;
    _lifecycleListener?.dispose();
    _lifecycleListener = null;
  }

  Future<void> _startRun(OutboxRunReason reason) async {
    if (_isDisposed) return;
    _wakeUpTimer?.cancel();
    _wakeUpTimer = null;
    final result = await _sender.run(reason);
    if (_isDisposed) return;
    switch (result) {
      case OutboxRunAlreadyUnderWay():
        // The run under way sets the wake-up when it ends.
        return;
      case OutboxRunEnded(:final nextWakeUpAt):
        _wakeUpAt = nextWakeUpAt;
        _setWakeUpTimer();
    }
  }

  void _setWakeUpTimer() {
    _wakeUpTimer?.cancel();
    _wakeUpTimer = null;
    final wakeUpAt = _wakeUpAt;
    if (wakeUpAt == null || !_isInForeground) return;
    final delay = wakeUpAt.difference(_clock.now());
    _wakeUpTimer = Timer(delay.isNegative ? Duration.zero : delay, () {
      _wakeUpTimer = null;
      unawaited(_startRun(OutboxRunReason.wakeUp));
    });
  }

  void _followLifecycle(AppLifecycleState lifecycleState) {
    final wasInForeground = _isInForeground;
    _isInForeground = _isForeground(lifecycleState);
    if (!_isInForeground) {
      _wakeUpTimer?.cancel();
      _wakeUpTimer = null;
      return;
    }
    if (!wasInForeground) unawaited(_startRun(OutboxRunReason.appResumed));
  }

  /// Resumed or inactive (the notification shade over the app) is the foreground, as for the
  /// recognition flow (S4-D23).
  static bool _isForeground(AppLifecycleState? lifecycleState) => switch (lifecycleState) {
    null || AppLifecycleState.resumed || AppLifecycleState.inactive => true,
    AppLifecycleState.hidden || AppLifecycleState.paused || AppLifecycleState.detached => false,
  };
}
