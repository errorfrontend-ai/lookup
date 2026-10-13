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
/// restart; one stored further away than an hour (the phone's clock went back) counts as an hour
/// away, and a probe time as at most 6 hours away (§3.9 point 9).
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

  OutboxIndex withItemReplaced(OutboxItem replacement) => _with(
    items: [for (final item in items) item.itemId == replacement.itemId ? replacement : item],
  );

  OutboxIndex withGroupPausedUntil(OutboxItemGroup group, DateTime until) =>
      _with(groupPausedUntil: {...groupPausedUntil, group: until.toUtc()});

  OutboxIndex withUpdatePause(OutboxUpdatePause? updatePause) =>
      OutboxIndex(items: items, groupPausedUntil: groupPausedUntil, updatePause: updatePause);

  /// The item with [itemId], or null when it is no longer queued.
  OutboxItem? itemWithId(String itemId) {
    for (final item in items) {
      if (item.itemId == itemId) return item;
    }
    return null;
  }

  /// This index without what has run out at [now]: follow-up items queued 7 days ago or more
  /// (§3.8; contract R5), group pauses that have ended, and a 426 pause made by another version of
  /// the app than [appVersion] (amendment A2).
  OutboxIndex withoutExpired({required DateTime now, required String appVersion}) {
    final followUpLifetime = const Duration(seconds: OutboxTimingRules.followUpItemLifetimeSeconds);
    return OutboxIndex(
      items: [
        for (final item in items)
          if (item.kind.group != OutboxItemGroup.followUps ||
              now.isBefore(item.queuedAt.add(followUpLifetime)))
            item,
      ],
      groupPausedUntil: {
        for (final MapEntry(key: group, value: until) in groupPausedUntil.entries)
          if (now.isBefore(until)) group: until,
      },
      updatePause: updatePause?.appVersion == appVersion ? updatePause : null,
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
      if (nextAttemptAt != null && _cutWait(nextAttemptAt, now).isAfter(now)) continue;
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
  /// probe. Null when nothing is queued.
  DateTime? nextWakeUpAt(DateTime now) {
    if (items.isEmpty) return null;
    final updatePause = this.updatePause;
    if (updatePause != null) return updatePause.nextProbeAtSeenFrom(now);
    DateTime? earliest;
    for (final item in items) {
      final itemDueAt = switch (item.nextAttemptAt) {
        final nextAttemptAt? => _cutWait(nextAttemptAt, now),
        null => now,
      };
      final pausedUntil = groupPausedUntil[item.kind.group];
      final groupDueAt = pausedUntil == null ? now : _cutWait(pausedUntil, now);
      final dueAt = itemDueAt.isAfter(groupDueAt) ? itemDueAt : groupDueAt;
      if (earliest == null || dueAt.isBefore(earliest)) earliest = dueAt;
    }
    return earliest;
  }

  bool _isGroupPaused(OutboxItemGroup group, DateTime now) {
    final pausedUntil = groupPausedUntil[group];
    return pausedUntil != null && _cutWait(pausedUntil, now).isAfter(now);
  }

  /// [at], or an hour from [now] when [at] is further away: the clock went back after the wait was
  /// set.
  static DateTime _cutWait(DateTime at, DateTime now) {
    final latest = now.add(OutboxTimingRules.longestStoredWait);
    return at.isAfter(latest) ? latest : at;
  }

  /// What "oldest" means for [item]: its queued time (clips will go by capture time, piece 3).
  static DateTime _sendingOrderOf(OutboxItem item) => switch (item) {
    StationChoiceItem(:final queuedAt) => queuedAt,
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
        // Kinds a later piece queues; this version cannot send them.
        OutboxItemKind.deferredClip ||
        OutboxItemKind.engagement ||
        OutboxItemKind.recognitionReport ||
        OutboxItemKind.clientErrorReport ||
        null => null,
      };
    }
    return null;
  }

  static String _writeTime(DateTime time) => time.toUtc().toIso8601String();

  static DateTime? _readTime(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toUtc() : null;
}

/// The pause a 426 `APP_UPDATE_REQUIRED` puts on the whole outbox (contract R11, amendment A2). It
/// ends when the app's version differs from [appVersion], or when a probe gets any answer but 426.
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

  /// [nextProbeAt], or 6 hours from [now] when it is further away: the clock went back.
  DateTime nextProbeAtSeenFrom(DateTime now) {
    final latest = now.add(OutboxTimingRules.updatePauseProbeInterval);
    return nextProbeAt.isAfter(latest) ? latest : nextProbeAt;
  }

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
