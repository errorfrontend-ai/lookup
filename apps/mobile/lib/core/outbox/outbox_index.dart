import 'outbox_item.dart';
import 'outbox_item_group.dart';
import 'outbox_item_kind.dart';
import 'outbox_timing_rules.dart';

/// The outbox's queue as `index.json` holds it (P6 design §3.8): its items, the groups paused by a
/// `Retry-After`, and the pause a 426 puts on everything. Immutable: every change gives a new index,
/// which the store writes whole.
///
/// It also answers the sender's questions about time: which item is due, which may probe a 426
/// pause, and when the next one falls due. Waits are wall-clock times, because they must survive a
/// restart; [withoutExpired] cuts one stored further away than an hour (the phone's clock went
/// back) to an hour from now, and a probe time to 6 hours from now, and the sender writes the cut
/// (§3.9 point 9).
final class OutboxIndex {
  OutboxIndex({
    List<OutboxItem> items = const [],
    Map<OutboxItemGroup, DateTime> groupPausedUntil = const {},
    this.updatePause,
  }) : items = List.unmodifiable(items),
       groupPausedUntil = Map.unmodifiable(groupPausedUntil);

  /// An outbox with nothing in it.
  static final OutboxIndex empty = OutboxIndex();

  /// The index file's format, written as `format_version`.
  static const int formatVersion = 1;

  /// In the order they were queued.
  final List<OutboxItem> items;

  /// Groups a `Retry-After` paused, and until when (UTC).
  final Map<OutboxItemGroup, DateTime> groupPausedUntil;

  /// The 426 pause, while it holds; null otherwise.
  final OutboxUpdatePause? updatePause;

  bool get isEmpty => items.isEmpty;

  OutboxIndex withItemAdded(OutboxItem item) => _with(items: [...items, item]);

  OutboxIndex withItemRemoved(String itemId) => _with(
    items: [
      for (final item in items)
        if (item.itemId != itemId) item,
    ],
  );

  /// This index without the items named in [itemIds]; this same index when it holds none of them.
  OutboxIndex withItemsRemoved(Set<String> itemIds) {
    if (!items.any((item) => itemIds.contains(item.itemId))) return this;
    return _with(
      items: [
        for (final item in items)
          if (!itemIds.contains(item.itemId)) item,
      ],
    );
  }

  OutboxIndex withItemReplaced(OutboxItem replacement) => _with(
    items: [for (final item in items) item.itemId == replacement.itemId ? replacement : item],
  );

  OutboxIndex withGroupPausedUntil(OutboxItemGroup group, DateTime until) =>
      _with(groupPausedUntil: {...groupPausedUntil, group: until.toUtc()});

  OutboxIndex withUpdatePause(OutboxUpdatePause? updatePause) =>
      OutboxIndex(items: items, groupPausedUntil: groupPausedUntil, updatePause: updatePause);

  /// This index with the 426 pause's next probe at [nextProbeAt]; unchanged when no pause holds.
  OutboxIndex withNextProbeAt(DateTime nextProbeAt) => switch (updatePause) {
    final pause? => withUpdatePause(pause.withNextProbeAt(nextProbeAt)),
    null => this,
  };

  /// The item with [itemId], or null when it is no longer queued.
  OutboxItem? itemWithId(String itemId) {
    for (final item in items) {
      if (item.itemId == itemId) return item;
    }
    return null;
  }

  /// The clips that [withoutExpired] deletes at [now], each with why (§3.8, P6-D37): History keeps a
  /// row for each, "Not sent within 24 hours — deleted" or "Couldn't be checked — deleted".
  List<OutboxExpiredClip> expiredClips(DateTime now) => [
    for (final item in items)
      if (item is DeferredClipItem)
        if (_clipExpiryOf(item, now) case final reason?)
          OutboxExpiredClip(item: item, reason: reason),
  ];

  /// This index with every wait that came from "no answer" cleared: the network came back, so their
  /// reason has gone (§3.9 point 9). Waits the server asked for (a `Retry-After`, a 5xx backoff, a
  /// pause) stay. This same index when there is none.
  OutboxIndex withNoAnswerWaitsCleared() {
    bool isNoAnswerWait(OutboxItem item) =>
        item.lastProblem == OutboxItemProblem.noAnswer && item.nextAttemptAt != null;
    if (!items.any(isNoAnswerWait)) return this;
    return _with(
      items: [for (final item in items) isNoAnswerWait(item) ? item.withoutWait() : item],
    );
  }

  /// The clips waiting, oldest capture first.
  List<DeferredClipItem> get clips => [
    for (final item in items)
      if (item is DeferredClipItem) item,
  ]..sort((first, second) => first.capturedAt.compareTo(second.capturedAt));

  /// This index as it should be at [now] (§3.8, §3.9 point 9; contract R5; amendment A2):
  /// - without what has run out: clips 23 hours 58 minutes after their capture by the phone's clock,
  ///   or captured more than 2 minutes ahead of it ([expiredClips]); follow-up items and crash
  ///   reports queued 7 days ago or more; group pauses that have ended; and a 426 pause made by
  ///   another version of the app than [appVersion];
  /// - with every wait cut to what the clock allows. An item's wait or a group's pause ending more
  ///   than an hour after [now], or a probe due more than 6 hours after it, was set while the
  ///   phone's clock was ahead, and the clock has gone back since: it is cut to an hour (a probe to
  ///   6 hours) from [now]. The sender writes the cut, so the wait then really ends, rather than
  ///   staying an hour away each time it is looked at.
  ///
  /// This same index when nothing has run out or been cut, so a caller can tell with `identical`
  /// whether there is anything to write.
  OutboxIndex withoutExpired({required DateTime now, required String appVersion}) {
    final followUpLifetime = const Duration(seconds: OutboxTimingRules.followUpItemLifetimeSeconds);
    final latestWaitEnd = now.toUtc().add(OutboxTimingRules.longestStoredWait);
    final latestProbeAt = now.toUtc().add(OutboxTimingRules.updatePauseProbeInterval);
    var isChanged = false;
    final keptItems = <OutboxItem>[];
    for (final item in items) {
      final hasExpired = switch (item) {
        DeferredClipItem() => _clipExpiryOf(item, now) != null,
        StationChoiceItem() ||
        RecognitionReportItem() ||
        ClientErrorReportItem() => !now.isBefore(item.queuedAt.add(followUpLifetime)),
      };
      if (hasExpired) {
        isChanged = true;
      } else if (item.nextAttemptAt case final nextAttemptAt?
          when nextAttemptAt.isAfter(latestWaitEnd)) {
        keptItems.add(item.withNextAttemptAt(latestWaitEnd));
        isChanged = true;
      } else {
        keptItems.add(item);
      }
    }
    final keptGroupPauses = <OutboxItemGroup, DateTime>{};
    for (final MapEntry(key: group, value: until) in groupPausedUntil.entries) {
      if (!now.isBefore(until)) {
        isChanged = true;
      } else if (until.isAfter(latestWaitEnd)) {
        keptGroupPauses[group] = latestWaitEnd;
        isChanged = true;
      } else {
        keptGroupPauses[group] = until;
      }
    }
    final keptUpdatePause = switch (updatePause) {
      final pause? when pause.appVersion != appVersion => null,
      final pause? when pause.nextProbeAt.isAfter(latestProbeAt) => pause.withNextProbeAt(
        latestProbeAt,
      ),
      final pause => pause,
    };
    if (!identical(keptUpdatePause, updatePause)) isChanged = true;
    if (!isChanged) return this;
    return OutboxIndex(
      items: keptItems,
      groupPausedUntil: keptGroupPauses,
      updatePause: keptUpdatePause,
    );
  }

  /// The item to send at [now], or null when none is due: the oldest of the items whose own wait
  /// has ended and whose group is not paused (P6-OFFLINE-11). Ignores the 426 pause, which the
  /// sender checks first.
  OutboxItem? nextDueItem(DateTime now) {
    OutboxItem? oldest;
    for (final item in items) {
      if (_isGroupPaused(item.kind.group, now)) continue;
      final nextAttemptAt = item.nextAttemptAt;
      if (nextAttemptAt != null && nextAttemptAt.isAfter(now)) continue;
      if (oldest == null || _sendingOrderOf(item).isBefore(_sendingOrderOf(oldest))) oldest = item;
    }
    return oldest;
  }

  /// The item a 426 pause's probe sends: the oldest follow-up or crash report if there is one,
  /// else the oldest clip, whatever its own wait (amendment A2).
  OutboxItem? probeItem() {
    OutboxItem? oldestOf(bool Function(OutboxItem item) isWanted) {
      OutboxItem? oldest;
      for (final item in items.where(isWanted)) {
        if (oldest == null || _sendingOrderOf(item).isBefore(_sendingOrderOf(oldest))) {
          oldest = item;
        }
      }
      return oldest;
    }

    return oldestOf((item) => item.kind.group != OutboxItemGroup.clips) ??
        oldestOf((item) => item.kind.group == OutboxItemGroup.clips);
  }

  /// When the next run should start by itself, seen from [now] (amendment A1): the earliest time
  /// an item falls due, after its own wait and its group's pause; while a 426 pause holds, its next
  /// probe. Null when nothing is queued. Asked of an index [withoutExpired] has cleaned, so no wait
  /// in it is further away than the clock allows.
  DateTime? nextWakeUpAt(DateTime now) {
    if (items.isEmpty) return null;
    final updatePause = this.updatePause;
    if (updatePause != null) return updatePause.nextProbeAt;
    DateTime? earliest;
    for (final item in items) {
      final itemDueAt = item.nextAttemptAt ?? now;
      final groupDueAt = groupPausedUntil[item.kind.group] ?? now;
      final dueAt = itemDueAt.isAfter(groupDueAt) ? itemDueAt : groupDueAt;
      if (earliest == null || dueAt.isBefore(earliest)) earliest = dueAt;
    }
    return earliest;
  }

  bool _isGroupPaused(OutboxItemGroup group, DateTime now) =>
      groupPausedUntil[group]?.isAfter(now) ?? false;

  /// Why [clip] must be deleted unsent at [now], or null while it may still go (§3.8, P6-D37): 23
  /// hours 58 minutes after its capture by the phone's clock, so a clock moved back by less than 2
  /// minutes cannot stretch it past 24 hours of real time; or at once when its capture time is more
  /// than 2 minutes ahead of the clock (the clock went back; the server would refuse it anyway).
  static OutboxClipExpiry? _clipExpiryOf(DeferredClipItem clip, DateTime now) {
    if (clip.capturedAt.isAfter(now.add(OutboxTimingRules.clipCaptureTimeAheadAllowance))) {
      return OutboxClipExpiry.captureTimeAheadOfTheClock;
    }
    if (!now.isBefore(clip.capturedAt.add(OutboxTimingRules.clipKeptFor))) {
      return OutboxClipExpiry.notSentWithin24Hours;
    }
    return null;
  }

  /// What "oldest" means for [item]: a clip's capture time, any other item's queued time (contract
  /// R7).
  static DateTime _sendingOrderOf(OutboxItem item) => switch (item) {
    DeferredClipItem(:final capturedAt) => capturedAt,
    StationChoiceItem(:final queuedAt) ||
    RecognitionReportItem(:final queuedAt) ||
    ClientErrorReportItem(:final queuedAt) => queuedAt,
  };

  OutboxIndex _with({List<OutboxItem>? items, Map<OutboxItemGroup, DateTime>? groupPausedUntil}) =>
      OutboxIndex(
        items: items ?? this.items,
        groupPausedUntil: groupPausedUntil ?? this.groupPausedUntil,
        updatePause: updatePause,
      );

  /// The index as `index.json` holds it.
  Map<String, Object?> toJson() => {
    'format_version': formatVersion,
    'group_paused_until': {
      for (final MapEntry(key: group, value: until) in groupPausedUntil.entries)
        group.storedName: _writeTime(until),
    },
    'update_pause': updatePause?.toJson(),
    'items': [for (final item in items) _itemToJson(item)],
  };

  /// Reads `index.json`'s decoded [json]. Throws [FormatException] when it is not an outbox index of
  /// this format at all; an item that cannot be read (an unknown kind, a missing field) is left
  /// out and counted, so one broken item never loses the others.
  static ({OutboxIndex index, int unreadableItemCount}) fromJson(Object? json) {
    if (json case {
      'format_version': OutboxIndex.formatVersion,
      'items': final List<Object?> storedItems,
    }) {
      final items = <OutboxItem>[];
      var unreadableItemCount = 0;
      for (final storedItem in storedItems) {
        final item = _itemFromJson(storedItem);
        if (item == null) {
          unreadableItemCount++;
        } else {
          items.add(item);
        }
      }
      final storedPauses = json['group_paused_until'];
      return (
        index: OutboxIndex(
          items: items,
          groupPausedUntil: {
            if (storedPauses is Map<Object?, Object?>)
              for (final MapEntry(:key, :value) in storedPauses.entries)
                if ((OutboxItemGroup.fromStoredName(key), _readTime(value)) case (
                  final group?,
                  final until?,
                ))
                  group: until,
          },
          updatePause: OutboxUpdatePause.fromJson(json['update_pause']),
        ),
        unreadableItemCount: unreadableItemCount,
      );
    }
    throw const FormatException('Not an outbox index of format 1.');
  }

  static Map<String, Object?> _itemToJson(OutboxItem item) => {
    'item_id': item.itemId,
    'kind': item.kind.wireName,
    'queued_at': _writeTime(item.queuedAt),
    'attempt_count': item.attemptCount,
    'next_attempt_at': switch (item.nextAttemptAt) {
      final nextAttemptAt? => _writeTime(nextAttemptAt),
      null => null,
    },
    'last_problem': item.lastProblem?.storedName,
    ...switch (item) {
      StationChoiceItem(:final recognitionId, :final stationId) => {
        'recognition_id': recognitionId,
        'station_id': stationId,
      },
      DeferredClipItem() => {
        'idempotency_key': item.idempotencyKey,
        'captured_at': _writeTime(item.capturedAt),
        'clip_duration_milliseconds': item.clipDurationMilliseconds,
        'codec': item.codec,
        'station_hint_id': item.stationHintId,
        'audio_file': item.audioFileName,
        'audio_size_bytes': item.audioSizeBytes,
        'saved_reason': item.savedReason.storedName,
      },
      RecognitionReportItem(:final recognitionId, :final stationId, :final reason) => {
        'recognition_id': recognitionId,
        'station_id': stationId,
        'reason': reason,
      },
      ClientErrorReportItem() => {
        'report_id': item.reportId,
        'occurred_at': _writeTime(item.occurredAt),
        'fields': item.fields,
      },
    },
  };

  static OutboxItem? _itemFromJson(Object? json) {
    if (json case {
      'item_id': final String itemId,
      'kind': final String kindName,
      'queued_at': final String queuedAtText,
      'attempt_count': final int attemptCount,
    } when attemptCount >= 0) {
      final queuedAt = _readTime(queuedAtText);
      if (queuedAt == null) return null;
      final nextAttemptAt = _readTime(json['next_attempt_at']);
      final lastProblem = OutboxItemProblem.fromStoredName(json['last_problem']);
      return switch (OutboxItemKind.fromWireName(kindName)) {
        OutboxItemKind.stationChoice => switch (json) {
          {'recognition_id': final String recognitionId, 'station_id': final String stationId} =>
            StationChoiceItem(
              itemId: itemId,
              queuedAt: queuedAt,
              recognitionId: recognitionId,
              stationId: stationId,
              attemptCount: attemptCount,
              nextAttemptAt: nextAttemptAt,
              lastProblem: lastProblem,
            ),
          _ => null,
        },
        OutboxItemKind.deferredClip => switch (json) {
          {
            'idempotency_key': final String idempotencyKey,
            'captured_at': final String capturedAtText,
            'clip_duration_milliseconds': final int clipDurationMilliseconds,
            'codec': final String codec,
            'audio_file': final String audioFileName,
            'audio_size_bytes': final int audioSizeBytes,
            'saved_reason': final String savedReasonName,
          }
              when _isClipFileName(audioFileName) && audioSizeBytes >= 0 =>
            switch ((
              _readTime(capturedAtText),
              DeferredClipSavedReason.fromStoredName(savedReasonName),
              json['station_hint_id'],
            )) {
              (final capturedAt?, final savedReason?, final String? stationHintId) =>
                DeferredClipItem(
                  itemId: itemId,
                  queuedAt: queuedAt,
                  idempotencyKey: idempotencyKey,
                  capturedAt: capturedAt,
                  clipDurationMilliseconds: clipDurationMilliseconds,
                  codec: codec,
                  stationHintId: stationHintId,
                  audioFileName: audioFileName,
                  audioSizeBytes: audioSizeBytes,
                  savedReason: savedReason,
                  attemptCount: attemptCount,
                  nextAttemptAt: nextAttemptAt,
                  lastProblem: lastProblem,
                ),
              _ => null,
            },
          _ => null,
        },
        OutboxItemKind.clientErrorReport => switch (json) {
          {
            'report_id': final String reportId,
            'occurred_at': final String occurredAtText,
            'fields': final Map<String, Object?> fields,
          }
              when fields.values.every((value) => value is String) =>
            switch (_readTime(occurredAtText)) {
              final occurredAt? => ClientErrorReportItem(
                itemId: itemId,
                queuedAt: queuedAt,
                reportId: reportId,
                occurredAt: occurredAt,
                fields: fields.cast<String, String>(),
                attemptCount: attemptCount,
                nextAttemptAt: nextAttemptAt,
                lastProblem: lastProblem,
              ),
              null => null,
            },
          _ => null,
        },
        OutboxItemKind.recognitionReport => switch (json) {
          {
            'recognition_id': final String recognitionId,
            'station_id': final String stationId,
            'reason': final String reason,
          }
              when RecognitionReportItem.reasons.contains(reason) =>
            RecognitionReportItem(
              itemId: itemId,
              queuedAt: queuedAt,
              recognitionId: recognitionId,
              stationId: stationId,
              reason: reason,
              attemptCount: attemptCount,
              nextAttemptAt: nextAttemptAt,
              lastProblem: lastProblem,
            ),
          _ => null,
        },
        // A kind a later piece queues; this version cannot send it.
        OutboxItemKind.engagement || null => null,
      };
    }
    return null;
  }

  /// A clip's file name as the store makes it: a UUID and `.m4a`, never a path, so an index that was
  /// tampered with cannot name a file outside `clips/`.
  static bool _isClipFileName(String name) => _clipFileName.hasMatch(name);

  static final RegExp _clipFileName = RegExp(r'^[0-9a-f-]{36}\.m4a$');

  static String _writeTime(DateTime time) => time.toUtc().toIso8601String();

  static DateTime? _readTime(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toUtc() : null;
}

/// A clip deleted unsent, and why (§3.8): History keeps a row for it.
final class OutboxExpiredClip {
  const OutboxExpiredClip({required this.item, required this.reason});

  final DeferredClipItem item;
  final OutboxClipExpiry reason;
}

/// Why a waiting clip was deleted unsent (P6 design §3.8, §3.11).
enum OutboxClipExpiry {
  /// Its 24 hours ran out: "Not sent within 24 hours — deleted".
  notSentWithin24Hours,

  /// Its capture time is more than 2 minutes ahead of the phone's clock: "Couldn't be checked —
  /// deleted".
  captureTimeAheadOfTheClock,
}

/// The pause a 426 `APP_UPDATE_REQUIRED` puts on the whole outbox (contract R11, amendment A2). It
/// ends when the app's version differs from [appVersion], or when the server answers a probe with
/// anything but 426; a probe with no answer, or stopped by a fault on the phone, leaves it.
final class OutboxUpdatePause {
  const OutboxUpdatePause({
    required this.appVersion,
    required this.pausedAt,
    required this.nextProbeAt,
  });

  /// The app version that got the 426; a different running version ends the pause.
  final String appVersion;

  /// When the 426 came (UTC).
  final DateTime pausedAt;

  /// When the next probe may go (UTC): 6 hours after the last; one also goes at every app start.
  final DateTime nextProbeAt;

  /// This pause with its next probe at [nextProbeAt].
  OutboxUpdatePause withNextProbeAt(DateTime nextProbeAt) => OutboxUpdatePause(
    appVersion: appVersion,
    pausedAt: pausedAt,
    nextProbeAt: nextProbeAt.toUtc(),
  );

  Map<String, Object?> toJson() => {
    'app_version': appVersion,
    'paused_at': pausedAt.toUtc().toIso8601String(),
    'next_probe_at': nextProbeAt.toUtc().toIso8601String(),
  };

  /// The pause stored as [json], or null when there is none or it cannot be read (which ends it:
  /// the next 426 starts it again).
  static OutboxUpdatePause? fromJson(Object? json) {
    if (json case {
      'app_version': final String appVersion,
      'paused_at': final String pausedAtText,
      'next_probe_at': final String nextProbeAtText,
    }) {
      final pausedAt = DateTime.tryParse(pausedAtText)?.toUtc();
      final nextProbeAt = DateTime.tryParse(nextProbeAtText)?.toUtc();
      if (pausedAt == null || nextProbeAt == null) return null;
      return OutboxUpdatePause(
        appVersion: appVersion,
        pausedAt: pausedAt,
        nextProbeAt: nextProbeAt,
      );
    }
    return null;
  }
}
