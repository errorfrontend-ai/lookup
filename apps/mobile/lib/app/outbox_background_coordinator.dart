import 'dart:async';
import 'dart:isolate';
import 'dart:ui' show IsolateNameServer;

import 'package:flutter/widgets.dart';
import 'package:lookup_listener/app/background_work_scheduler.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';

/// The foreground engine's side of the outbox's background job (P6 design §3.10; P6-OFFLINE-08):
///
/// - asks for the one-off send when an item is queued, and when the app is hidden with items
///   waiting, so they go once a network is connected even if the app is closed;
/// - keeps the six-hourly expiry job only while a clip waits or the 426 pause holds, and cancels it
///   when neither does;
/// - while the app is resumed, answers the background job through the port [portName]: the job asks
///   this engine to run the sender and ends, so two engines never send at once.
///
/// Nothing here throws: a request WorkManager refuses is reported, and the clips still go at the
/// next start or resume.
class OutboxBackgroundCoordinator {
  OutboxBackgroundCoordinator({
    required OutboxStore store,
    required BackgroundWorkScheduler scheduler,
    required ClientErrorReporter clientErrorReporter,
    required void Function() onRunRequested,
  }) : _store = store,
       _scheduler = scheduler,
       _clientErrorReporter = clientErrorReporter,
       _onRunRequested = onRunRequested;

  /// The name the foreground engine's port is found by, process-wide.
  static const String portName = 'look-up-outbox';

  /// Whether [index] needs the expiry job: a clip waits (to be deleted on time), or the 426 pause
  /// holds (to send its six-hourly probe).
  static bool isExpiryJobNeeded(OutboxIndex index) =>
      index.clips.isNotEmpty || index.updatePause != null;

  final OutboxStore _store;
  final BackgroundWorkScheduler _scheduler;
  final ClientErrorReporter _clientErrorReporter;
  final void Function() _onRunRequested;

  AppLifecycleListener? _lifecycleListener;
  StreamSubscription<void>? _itemsQueuedSubscription;
  StreamSubscription<void>? _changedSubscription;
  ReceivePort? _port;
  bool? _isExpiryJobScheduled;
  bool _isStarted = false;
  bool _isDisposed = false;

  /// Starts following the app and the outbox. Called once, after the app's first frame.
  void start() {
    if (_isStarted || _isDisposed) return;
    _isStarted = true;
    _lifecycleListener = AppLifecycleListener(onStateChange: _followLifecycle);
    _itemsQueuedSubscription = _store.itemsQueued.listen((_) => unawaited(_scheduleSend()));
    _changedSubscription = _store.changed.listen((_) => unawaited(syncExpiryJob()));
    if (_isForeground(WidgetsBinding.instance.lifecycleState)) _openPort();
    unawaited(syncExpiryJob());
  }

  /// Keeps the expiry job exactly while the outbox needs it. Asks WorkManager only when the answer
  /// changes from what this engine last asked.
  Future<void> syncExpiryJob() async {
    try {
      final isNeeded = isExpiryJobNeeded(await _store.read());
      if (_isExpiryJobScheduled == isNeeded) return;
      if (isNeeded) {
        await _scheduler.scheduleExpiryChecks();
      } else {
        await _scheduler.cancelExpiryChecks();
      }
      _isExpiryJobScheduled = isNeeded;
    } on Object catch (error, stackTrace) {
      _report('Scheduling the outbox expiry job failed', error, stackTrace);
    }
  }

  /// Stops following them, and closes the port.
  void dispose() {
    _isDisposed = true;
    _closePort();
    unawaited(_itemsQueuedSubscription?.cancel());
    _itemsQueuedSubscription = null;
    unawaited(_changedSubscription?.cancel());
    _changedSubscription = null;
    _lifecycleListener?.dispose();
    _lifecycleListener = null;
  }

  void _followLifecycle(AppLifecycleState lifecycleState) {
    if (lifecycleState == AppLifecycleState.resumed) {
      _openPort();
      return;
    }
    if (_isForeground(lifecycleState)) return;
    _closePort();
    unawaited(_scheduleSendIfWaiting());
  }

  Future<void> _scheduleSendIfWaiting() async {
    try {
      if ((await _store.read()).isEmpty) return;
    } on Object {
      // The send is asked for anyway: the job reads the outbox itself.
    }
    await _scheduleSend();
  }

  Future<void> _scheduleSend() async {
    if (_isDisposed) return;
    try {
      await _scheduler.scheduleSend();
    } on Object catch (error, stackTrace) {
      _report('Scheduling the outbox send job failed', error, stackTrace);
    }
  }

  /// Registers this engine's port, replacing a mapping a closed engine left behind.
  void _openPort() {
    if (_port != null || _isDisposed) return;
    final port = ReceivePort();
    port.listen((message) {
      if (message is! SendPort) return;
      _onRunRequested();
      message.send(true);
    });
    if (!IsolateNameServer.registerPortWithName(port.sendPort, portName)) {
      IsolateNameServer.removePortNameMapping(portName);
      IsolateNameServer.registerPortWithName(port.sendPort, portName);
    }
    _port = port;
  }

  void _closePort() {
    final port = _port;
    if (port == null) return;
    _port = null;
    if (IsolateNameServer.lookupPortByName(portName) == port.sendPort) {
      IsolateNameServer.removePortNameMapping(portName);
    }
    port.close();
  }

  void _report(String description, Object error, StackTrace stackTrace) {
    unawaited(
      _clientErrorReporter
          .report(
            kind: ClientErrorKind.reported,
            error: error,
            stackTrace: stackTrace,
            description: description,
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }

  /// Resumed or inactive (the notification shade over the app) is the foreground (S4-D23).
  static bool _isForeground(AppLifecycleState? lifecycleState) => switch (lifecycleState) {
    null || AppLifecycleState.resumed || AppLifecycleState.inactive => true,
    AppLifecycleState.hidden || AppLifecycleState.paused || AppLifecycleState.detached => false,
  };
}
