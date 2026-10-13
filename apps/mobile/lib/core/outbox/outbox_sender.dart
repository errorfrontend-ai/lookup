import 'dart:async';
import 'dart:math';

import '../configuration/app_version.dart';
import '../error_reporting/client_error_reporter.dart';
import '../files/owned_lock_file.dart';
import '../listener_install/listener_install_repository.dart';
import '../network/api_answer.dart';
import '../time/clock.dart';
import 'outbox_acknowledgement_policy.dart';
import 'outbox_action.dart';
import 'outbox_item_sender.dart';
import 'outbox_send_answer.dart';
import 'outbox_store.dart';
import 'outbox_timing_rules.dart';

/// Sends what waits in the outbox, one request at a time, for every kind (P6 design §3.9; contract
/// §3). A run:
///
/// 1. starts on app start, resume, a new item, and by itself after a wait (amendment A1); a run
///    already under way picks new items up, and a second never starts beside it;
/// 2. takes `sending.lock`, judged by its owner, never by its age (P6-D36);
/// 3. deletes expired items and ended pauses, and stops when nothing is left;
/// 4. waits once: a random whole number of seconds from 0 to 120, drawn once per run, not per item
///    (P6-OFFLINE-12); 0 to 10 when the item that started it was queued after the last run had
///    emptied the queue; none for a wake-up, whose wait was already jittered;
/// 5. honours the pauses: a group paused by a `Retry-After` is skipped while the others go on
///    (P6-D38); while a 426 holds everything, one probe goes at each app start and every 6 hours,
///    and any answer but 426 ends the pause, as does a new app version (amendment A2);
/// 6. registers when the install needs it, and after a refused token once per run (contract R10);
/// 7. sends the oldest due item, one at a time (P6-OFFLINE-10, -11), never while the listener's own
///    identify is under way, and applies [OutboxAcknowledgementPolicy] to each answer;
/// 8. ends on no answer: that item counts a failure and waits its backoff (P6-OUTBOX-04), and the
///    wake-up of point 1 starts the next run when it has passed.
///
/// [run] returns when the run is over, with the time of its wake-up, which the app's
/// `OutboxRunScheduler` sets while the app is in the foreground. It never throws: a failure on the
/// phone is reported and the run tries again later.
class OutboxSender {
  /// [itemSenders] has one sender per kind the app queues. [random] draws the run's wait, the
  /// backoff's factor and the deferred clips' busy wait; tests seed it. [isLiveIdentifyUnderWay]
  /// says whether the listener is recording, sending or waiting on Busy.
  OutboxSender({
    required OutboxStore store,
    required Map<OutboxItemKind, OutboxItemSender> itemSenders,
    required ListenerInstallRepository listenerInstallRepository,
    required ClientErrorReporter clientErrorReporter,
    required OutboxTimingRules timingRules,
    required Random random,
    required Clock clock,
    required bool Function() isLiveIdentifyUnderWay,
    String appVersion = AppVersion.current,
  }) : _store = store,
       _itemSenders = Map.unmodifiable(itemSenders),
       _listenerInstallRepository = listenerInstallRepository,
       _clientErrorReporter = clientErrorReporter,
       _timingRules = timingRules,
       _random = random,
       _clock = clock,
       _isLiveIdentifyUnderWay = isLiveIdentifyUnderWay,
       _appVersion = appVersion;

  final OutboxStore _store;
  final Map<OutboxItemKind, OutboxItemSender> _itemSenders;
  final ListenerInstallRepository _listenerInstallRepository;
  final ClientErrorReporter _clientErrorReporter;
  final OutboxTimingRules _timingRules;
  final Random _random;
  final Clock _clock;
  final bool Function() _isLiveIdentifyUnderWay;
  final String _appVersion;

  bool _isRunning = false;

  /// Set when an item was queued while a run was under way, so the run looks once more before it
  /// ends.
  bool _wasItemQueuedDuringRun = false;

  /// Whether the last run left the queue empty, which makes a new item's wait short (§3.9 point 5).
  bool _didLastRunEmptyQueue = false;

  /// Runs the sender once, for [reason]. Returns [OutboxRunAlreadyUnderWay] at once when a run is
  /// already going (which picks new items up), else [OutboxRunEnded] when the run is over.
  Future<OutboxRunResult> run(OutboxRunReason reason) async {
    if (_isRunning) {
      if (reason == OutboxRunReason.itemQueued) _wasItemQueuedDuringRun = true;
      return const OutboxRunAlreadyUnderWay();
    }
    _isRunning = true;
    OwnedLockFile? sendingLock;
    try {
      final lock = await _store.sendingLock();
      // Another engine is sending: it picks these items up.
      if (!lock.tryTake()) return const OutboxRunEnded(nextWakeUpAt: null);
      sendingLock = lock;
      final index = await _withoutExpired();
      if (index.isEmpty) {
        _didLastRunEmptyQueue = true;
        return const OutboxRunEnded(nextWakeUpAt: null);
      }
      final waitSeconds = _drawWaitSeconds(reason);
      _didLastRunEmptyQueue = false;
      if (waitSeconds > 0) await Future<void>.delayed(Duration(seconds: waitSeconds));
      final progress = _RunProgress(isProbeDue: reason == OutboxRunReason.appStarted);
      do {
        _wasItemQueuedDuringRun = false;
        await _sendWhatIsDue(progress);
      } while (_wasItemQueuedDuringRun && !progress.hasEnded);
      final finalIndex = await _store.read();
      _didLastRunEmptyQueue = finalIndex.isEmpty;
      return OutboxRunEnded(nextWakeUpAt: _nextWakeUpAt(finalIndex, progress));
    } on Object catch (error, stackTrace) {
      _report('An outbox run failed on the phone', error: error, stackTrace: stackTrace);
      return OutboxRunEnded(
        nextWakeUpAt: _clock.now().add(Duration(seconds: _timingRules.backoffFirstWaitSeconds)),
      );
    } finally {
      sendingLock?.release();
      _isRunning = false;
    }
  }

  int _drawWaitSeconds(OutboxRunReason reason) => switch (reason) {
    OutboxRunReason.wakeUp => 0,
    OutboxRunReason.itemQueued when _didLastRunEmptyQueue => _random.nextInt(
      _timingRules.newItemSendingDelayMaximumSeconds + 1,
    ),
    OutboxRunReason.appStarted ||
    OutboxRunReason.appResumed ||
    OutboxRunReason.itemQueued => _random.nextInt(_timingRules.sendingDelayMaximumSeconds + 1),
  };

  /// Sends due items one by one until none is due or the run ends.
  Future<void> _sendWhatIsDue(_RunProgress progress) async {
    while (!progress.hasEnded) {
      while (_isLiveIdentifyUnderWay()) {
        await Future<void>.delayed(OutboxTimingRules.liveIdentifyCheckInterval);
      }
      final index = await _withoutExpired();
      final now = _clock.now();
      final updatePause = index.updatePause;
      if (updatePause != null) {
        final isProbeTime =
            progress.isProbeDue || !now.isBefore(updatePause.nextProbeAtSeenFrom(now));
        progress.isProbeDue = false;
        final probe = isProbeTime ? index.probeItem() : null;
        if (probe == null) return;
        await _sendOne(probe, progress, isProbe: true);
      } else {
        final item = index.nextDueItem(now);
        if (item == null) return;
        await _sendOne(item, progress, isProbe: false);
      }
    }
  }

  Future<void> _sendOne(OutboxItem item, _RunProgress progress, {required bool isProbe}) async {
    final itemSender = _itemSenders[item.kind];
    if (itemSender == null) {
      await _apply(
        item,
        const OutboxDelete(isReported: true),
        OutboxPhoneFault(problem: 'no sender for ${item.kind.wireName} items'),
        progress,
      );
      return;
    }
    var registration = await _listenerInstallRepository.ensureRegistered();
    var answer = await _sendWithRegistration(itemSender, item, registration);
    var action = answer == null ? null : OutboxAcknowledgementPolicy.decide(item.kind, answer);
    if (action is OutboxRegisterAgainAndResend &&
        progress.registrationsAfterRefusedToken <
            OutboxTimingRules.registrationsAfterRefusedTokenPerRun &&
        registration is ListenerInstallRegistered) {
      // 401: once per run, register again with the same install id and send the item again.
      progress.registrationsAfterRefusedToken++;
      registration = await _listenerInstallRepository.registerAgainAfterRefusal(
        refusedToken: registration.installToken,
      );
      answer = await _sendWithRegistration(itemSender, item, registration);
      action = answer == null ? null : OutboxAcknowledgementPolicy.decide(item.kind, answer);
    }
    if (registration is ListenerInstallNotRegistered || answer == null || action == null) {
      await _applyRegistrationFailure(item, registration, progress);
      return;
    }
    if (action is OutboxRegisterAgainAndResend) {
      // The token was refused again in this run: the item is kept, counts a failure, and the run
      // ends (contract R10).
      await _apply(item, const OutboxItemBacksOff(endsRun: true), answer, progress);
      return;
    }
    if (isProbe) {
      if (answer is OutboxHttpAnswer && answer.httpStatus == 426) {
        await _keepUpdatePause(item, progress);
        return;
      }
      // Any other answer to a probe ends the 426 pause (amendment A2).
      await _apply(item, action, answer, progress, endsUpdatePause: true);
      return;
    }
    await _apply(item, action, answer, progress);
  }

  /// [item]'s answer, or null when the install has no token to send it with.
  Future<OutboxSendAnswer?> _sendWithRegistration(
    OutboxItemSender itemSender,
    OutboxItem item,
    ListenerInstallRegistrationResult registration,
  ) async => switch (registration) {
    ListenerInstallRegistered(:final installToken) => await itemSender.send(
      item,
      installToken: installToken,
    ),
    ListenerInstallNotRegistered() => null,
  };

  /// The install could not get a token. No answer to the registration counts as no answer for the
  /// item the run was about to send (§3.9 point 6); any other failure counts a failure too, and a
  /// refusal the app caused is reported. The run ends either way.
  Future<void> _applyRegistrationFailure(
    OutboxItem item,
    ListenerInstallRegistrationResult registration,
    _RunProgress progress,
  ) async {
    final answer = switch (registration) {
      ListenerInstallNotRegistered(:final answer) => answer,
      ListenerInstallRegistered() => null,
    };
    final isNetwork = switch (answer) {
      ApiAnswerNotReceived(reason: final reason) =>
        reason != ApiNoAnswerReason.plainHttpRefused &&
            reason != ApiNoAnswerReason.unexpectedFailure,
      _ => false,
    };
    final problem = switch (answer) {
      ApiAnswerReceived(status: 429) => OutboxItemProblem.limited,
      _ when isNetwork => OutboxItemProblem.noAnswer,
      _ => OutboxItemProblem.busy,
    };
    if (!isNetwork && answer is! ApiAnswerReceived) {
      _report('The outbox could not register the install before sending: ${answer?.runtimeType}');
    }
    await _keepWithBackoff(item, problem: problem);
    progress.endOnNoAnswer(await _nextAttemptOf(item));
  }

  /// A probe got 426 again: the pause stays and the next probe is 6 hours away (amendment A2).
  Future<void> _keepUpdatePause(OutboxItem item, _RunProgress progress) async {
    final now = _clock.now();
    await _store.modify((index) {
      final current = index.itemWithId(item.itemId);
      final withProbeTime = index.withUpdatePause(
        OutboxUpdatePause(
          appVersion: _appVersion,
          pausedAt: index.updatePause?.pausedAt ?? now,
          nextProbeAt: now.add(OutboxTimingRules.updatePauseProbeInterval),
        ),
      );
      if (current == null) return withProbeTime;
      return withProbeTime.withItemReplaced(
        current.retried(nextAttemptAt: null, lastProblem: OutboxItemProblem.updateRequired),
      );
    });
    progress.hasEnded = true;
  }

  /// Applies [action], decided from [answer], to [item] in the store, and ends the run when the
  /// action says so.
  Future<void> _apply(
    OutboxItem item,
    OutboxAction action,
    OutboxSendAnswer answer,
    _RunProgress progress, {
    bool endsUpdatePause = false,
  }) async {
    final now = _clock.now();
    final problem = _problemOf(answer);
    // Drawn here, once, so the change below stays a plain function of the index.
    final backoff = _timingRules.backoffAfter(failureCount: item.attemptCount + 1, random: _random);
    final pauseSeconds = switch (action) {
      OutboxPauseGroup(wait: OutboxWaitSeconds(:final seconds)) => seconds,
      OutboxPauseGroup(
        wait: OutboxWaitRandomSeconds(:final minimumSeconds, :final maximumSeconds),
      ) =>
        minimumSeconds + _random.nextInt(maximumSeconds - minimumSeconds + 1),
      _ => 0,
    };
    final written = await _store.modify((index) {
      final unpaused = endsUpdatePause ? index.withUpdatePause(null) : index;
      final current = unpaused.itemWithId(item.itemId);
      if (current == null) return unpaused;
      return switch (action) {
        OutboxDelete() => unpaused.withItemRemoved(item.itemId),
        OutboxItemWaits(:final seconds) => unpaused.withItemReplaced(
          current.retried(
            nextAttemptAt: now.add(Duration(seconds: seconds)),
            lastProblem: OutboxItemProblem.busy,
          ),
        ),
        OutboxItemBacksOff() => unpaused.withItemReplaced(
          current.retried(nextAttemptAt: now.add(backoff), lastProblem: problem),
        ),
        OutboxPauseGroup() =>
          unpaused
              .withGroupPausedUntil(item.kind.group, now.add(Duration(seconds: pauseSeconds)))
              .withItemReplaced(current.retried(nextAttemptAt: null, lastProblem: problem)),
        OutboxPauseAllUntilAppVersionChanges() =>
          unpaused
              .withUpdatePause(
                OutboxUpdatePause(
                  appVersion: _appVersion,
                  pausedAt: now,
                  nextProbeAt: now.add(OutboxTimingRules.updatePauseProbeInterval),
                ),
              )
              .withItemReplaced(
                current.retried(nextAttemptAt: null, lastProblem: OutboxItemProblem.updateRequired),
              ),
        // Settled before this point; kept with a backoff should one ever arrive here.
        OutboxRegisterAgainAndResend() => unpaused.withItemReplaced(
          current.retried(nextAttemptAt: now.add(backoff), lastProblem: problem),
        ),
      };
    });
    if (action case OutboxDelete(isReported: true)) {
      _report(
        'The outbox deleted a ${item.kind.wireName} item after $answer',
        relatedRequestId: answer is OutboxHttpAnswer ? answer.apiRequestId : null,
      );
    }
    switch (action) {
      case OutboxItemBacksOff(endsRun: true):
        progress.endOnNoAnswer(written.itemWithId(item.itemId)?.nextAttemptAt);
      case OutboxPauseAllUntilAppVersionChanges():
        progress.hasEnded = true;
      case OutboxDelete() ||
          OutboxItemWaits() ||
          OutboxItemBacksOff() ||
          OutboxPauseGroup() ||
          OutboxRegisterAgainAndResend():
        break;
    }
  }

  /// Keeps [item] with one failure more and its backoff, for a failure that is not the item's own
  /// answer (the registration before it).
  Future<void> _keepWithBackoff(OutboxItem item, {required OutboxItemProblem problem}) async {
    final now = _clock.now();
    final backoff = _timingRules.backoffAfter(failureCount: item.attemptCount + 1, random: _random);
    await _store.modify((index) {
      final current = index.itemWithId(item.itemId);
      if (current == null) return index;
      return index.withItemReplaced(
        current.retried(nextAttemptAt: now.add(backoff), lastProblem: problem),
      );
    });
  }

  Future<DateTime?> _nextAttemptOf(OutboxItem item) async =>
      (await _store.read()).itemWithId(item.itemId)?.nextAttemptAt;

  /// The index without expired items and ended pauses, written only when something ran out.
  Future<OutboxIndex> _withoutExpired() async {
    final index = await _store.read();
    final now = _clock.now();
    final cleaned = index.withoutExpired(now: now, appVersion: _appVersion);
    final isUnchanged =
        cleaned.items.length == index.items.length &&
        cleaned.groupPausedUntil.length == index.groupPausedUntil.length &&
        (cleaned.updatePause == null) == (index.updatePause == null);
    if (isUnchanged) return index;
    return _store.modify(
      (current) => current.withoutExpired(now: _clock.now(), appVersion: _appVersion),
    );
  }

  /// When the next run should start by itself. After a run that ended on no answer, never before
  /// that item's own wait has passed: the other items would only meet the same silence.
  DateTime? _nextWakeUpAt(OutboxIndex index, _RunProgress progress) {
    final next = index.nextWakeUpAt(_clock.now());
    final notBefore = progress.noAnswerRetryAt;
    if (next == null || notBefore == null) return next;
    return next.isBefore(notBefore) ? notBefore : next;
  }

  static OutboxItemProblem _problemOf(OutboxSendAnswer answer) => switch (answer) {
    OutboxNoAnswer() => OutboxItemProblem.noAnswer,
    OutboxHttpAnswer(httpStatus: 429) => OutboxItemProblem.limited,
    OutboxHttpAnswer(httpStatus: 426) => OutboxItemProblem.updateRequired,
    OutboxHttpAnswer() || OutboxPhoneFault() => OutboxItemProblem.busy,
  };

  /// Reports a failure the listener never sees, quietly: it never throws and never waits.
  void _report(
    String description, {
    Object? error,
    StackTrace? stackTrace,
    String? relatedRequestId,
  }) {
    unawaited(
      _clientErrorReporter
          .report(
            kind: ClientErrorKind.reported,
            error: error ?? description,
            description: error == null ? null : description,
            stackTrace: stackTrace,
            relatedRequestId: relatedRequestId,
          )
          .then<void>((_) {}, onError: (Object error) {}),
    );
  }
}

/// What started a run (§3.9 point 1), which decides its wait (point 5).
enum OutboxRunReason {
  /// The app started (after its first frame); also the 426 pause's probe.
  appStarted,

  /// The app came back to the foreground.
  appResumed,

  /// An item was queued.
  itemQueued,

  /// The wake-up after a wait (amendment A1): no new random wait.
  wakeUp,
}

/// How a call to [OutboxSender.run] ended.
sealed class OutboxRunResult {
  const OutboxRunResult();
}

/// The run is over. [nextWakeUpAt] is when the next should start by itself; null when nothing
/// waits, or another engine is sending.
final class OutboxRunEnded extends OutboxRunResult {
  const OutboxRunEnded({required this.nextWakeUpAt});

  final DateTime? nextWakeUpAt;
}

/// A run was already under way, and picks new items up; its own end sets the wake-up.
final class OutboxRunAlreadyUnderWay extends OutboxRunResult {
  const OutboxRunAlreadyUnderWay();
}

/// Where one run stands.
final class _RunProgress {
  _RunProgress({required this.isProbeDue});

  /// Whether a 426 pause's probe may go now: once at app start.
  bool isProbeDue;

  /// Registrations made in this run after a 401 (at most one, contract R10).
  int registrationsAfterRefusedToken = 0;

  /// Set when the run must stop sending.
  bool hasEnded = false;

  /// When the item that met no answer may go again; the wake-up is not earlier.
  DateTime? noAnswerRetryAt;

  void endOnNoAnswer(DateTime? retryAt) {
    hasEnded = true;
    noAnswerRetryAt = retryAt;
  }
}
