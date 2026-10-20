import 'package:device_services/device_services.dart';
import 'package:lookup_listener/core/outbox/outbox_index.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Where a saved clip's outcome goes (P6 design §3.9, §3.11, §2.16): History first, then the
/// notification. Lives in `lib/app`, because the identify feature's data never imports History's
/// (P6-D46).
///
/// - The History entry is keyed by the recognition id (or, with none, the clip's key), so a replay
///   after a lost answer changes nothing (contract R13), and it names the clip's key, so the clip's
///   waiting row disappears as the entry appears.
/// - **The notification's words never name the brand, the ad, the station or the outcome** (A6):
///   "Look Up" / "Your saved clip has been checked. Tap to see the result." for a match, a chooser
///   and a clip not recognised alike; none for a clip deleted unsent. Each recognition has its own
///   notification id, so two saved clips give two notifications and a replay updates its own.
/// - An entry is marked as notified only when notifications are on, and only such an entry may be
///   opened by a notification's launch id (§3.15).
final class DeferredResultHandler implements DeferredResultSink {
  DeferredResultHandler({
    required HistoryRepository history,
    required DeviceServices deviceServices,
    required AppLocalizations words,
  }) : _history = history,
       _deviceServices = deviceServices,
       _words = words;

  final HistoryRepository _history;
  final DeviceServices _deviceServices;
  final AppLocalizations _words;

  @override
  Future<void> record(DeferredClipOutcome outcome) async {
    final isNotified = _isNotifiedKind(outcome) && await _deviceServices.areNotificationsEnabled();
    final entryId = switch (outcome) {
      DeferredClipMatched(:final recognitionId) => recognitionId,
      DeferredClipAwaitingChoice(:final recognitionId) => recognitionId,
      DeferredClipAwaitingAccount(:final recognitionId) => recognitionId,
      DeferredClipNotIdentified(:final recognitionId, :final idempotencyKey) =>
        recognitionId ?? idempotencyKey,
    };
    switch (outcome) {
      case DeferredClipMatched(:final answerBody):
        await _history.saveResult(
          recognitionId: entryId,
          answer: answerBody,
          capturedAtOnPhone: outcome.capturedAtOnPhone,
          deferredIdempotencyKey: outcome.idempotencyKey,
          wasNotified: isNotified,
        );
      case DeferredClipAwaitingChoice(:final answerBody):
        await _history.saveAwaitingChoice(
          recognitionId: entryId,
          answer: answerBody,
          capturedAtOnPhone: outcome.capturedAtOnPhone,
          deferredIdempotencyKey: outcome.idempotencyKey,
          wasNotified: isNotified,
        );
      case DeferredClipAwaitingAccount(:final answerBody):
        await _history.saveAwaitingAccount(
          recognitionId: entryId,
          answer: answerBody,
          capturedAtOnPhone: outcome.capturedAtOnPhone,
          deferredIdempotencyKey: outcome.idempotencyKey,
          wasNotified: isNotified,
        );
      case DeferredClipNotIdentified(:final reason):
        await _history.saveNotIdentified(
          entryId: entryId,
          capturedAtOnPhone: outcome.capturedAtOnPhone,
          reason: reason,
          deferredIdempotencyKey: outcome.idempotencyKey,
          wasNotified: isNotified,
        );
    }
    if (!isNotified) return;
    await _deviceServices.showSavedClipNotification(
      notificationId: notificationIdFor(entryId),
      title: _words.savedClipNotificationTitle,
      text: _words.savedClipNotificationText,
      recognitionId: entryId,
      channelName: _words.savedClipNotificationChannelName,
      channelDescription: _words.savedClipNotificationChannelDescription,
    );
  }

  /// Keeps a History row for each clip the outbox deleted unsent (§3.8): no notification.
  Future<void> recordExpiredClips(List<OutboxExpiredClip> expiredClips) async {
    for (final expired in expiredClips) {
      await record(
        DeferredClipNotIdentified(
          idempotencyKey: expired.item.idempotencyKey,
          capturedAtOnPhone: expired.item.capturedAt,
          reason: switch (expired.reason) {
            OutboxClipExpiry.notSentWithin24Hours =>
              DeferredClipNotIdentifiedReason.notSentWithin24Hours,
            OutboxClipExpiry.captureTimeAheadOfTheClock =>
              DeferredClipNotIdentifiedReason.couldNotBeChecked,
          },
        ),
      );
    }
  }

  static bool _isNotifiedKind(DeferredClipOutcome outcome) => switch (outcome) {
    DeferredClipMatched() || DeferredClipAwaitingChoice() || DeferredClipAwaitingAccount() => true,
    DeferredClipNotIdentified(:final reason) => reason.isNotified,
  };

  /// A notification id for [entryId], the same on every run (FNV-1a, 31 bits), so a replay updates
  /// the notification it already posted instead of adding another.
  static int notificationIdFor(String entryId) {
    var hash = 0x811c9dc5;
    for (final unit in entryId.codeUnits) {
      hash ^= unit;
      hash = (hash * 0x01000193) & 0xffffffff;
    }
    return hash & 0x7fffffff;
  }
}
