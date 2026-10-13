import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_limits.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';
import 'package:lookup_listener/features/history/domain/stored_answer_reader.dart';

/// History (P6 design §2.9, §3.14): the results the listener saw, kept on the phone so their
/// buttons work again with no data (P6-HISTORY-01, -02).
///
/// - A result is kept with the API's answer **exactly as it came**, and read again by the answer's
///   own reader ([StoredAnswerReader]) every time it is shown; an entry the reader refuses is
///   dropped and reported, by count only.
/// - Entries are keyed by the recognition id, so the same answer saved twice (a replay) is one
///   entry (contract R13).
/// - At most 50 entries and none older than 30 days by the phone's capture time
///   ([HistoryLimits]); the oldest go first. Checked on every write, and at start
///   ([removeExpiredEntries]); an expired entry is never shown.
/// - [clear] empties it ("Clear history", Q7). Clips waiting to be sent join History, and so this,
///   with the outbox's clips in piece 3.
/// - [watchView] gives the view again after every write, so "Saved to History" and the History tab
///   follow a save at once (P6-HISTORY-14).
class HistoryRepository {
  /// [clock] is for tests; the app uses the real one.
  HistoryRepository({
    required HistoryStore store,
    required StoredAnswerReader answerReader,
    required ClientErrorReporter clientErrorReporter,
    Clock? clock,
  }) : _store = store,
       _answerReader = answerReader,
       _clientErrorReporter = clientErrorReporter,
       _clock = clock ?? Clock();

  final HistoryStore _store;
  final StoredAnswerReader _answerReader;
  final ClientErrorReporter _clientErrorReporter;
  final Clock _clock;

  final StreamController<void> _changes = StreamController<void>.broadcast(sync: true);

  /// Keeps the result [answer] shows: the API's 200 answer for [recognitionId] exactly as it came
  /// (a `MATCH`, or a `CHOOSE_STATION` with the [chosenStationId] the listener tapped), recorded by
  /// the phone at [capturedAtOnPhone]. A result already kept for [recognitionId] is replaced and
  /// keeps its first capture time. Throws [HistoryAnswerUnreadable] when the answer does not read
  /// as a result, so nothing is kept that could not be shown, and the store's own exceptions when
  /// it cannot write.
  Future<void> saveResult({
    required String recognitionId,
    required Object? answer,
    required DateTime capturedAtOnPhone,
    String? chosenStationId,
  }) async {
    final result = _answerReader.readResult(answer, chosenStationId: chosenStationId);
    if (result == null || result.recognitionId != recognitionId) {
      throw const HistoryAnswerUnreadable();
    }
    final now = _clock.now().toUtc();
    await _store.modify((entries) {
      final earlier = entries.where((entry) => entry.entryId == recognitionId).firstOrNull;
      final saved = StoredHistoryEntry(
        entryId: recognitionId,
        kind: StoredHistoryEntry.resultKind,
        capturedAtOnPhone: earlier?.capturedAtOnPhone ?? capturedAtOnPhone.toUtc(),
        savedAt: now,
        answer: answer,
        chosenStationId: chosenStationId,
      );
      return _withinLimits([
        saved,
        for (final entry in entries)
          if (entry.entryId != recognitionId) entry,
      ], now: now);
    });
    _changes.add(null);
  }

  /// What History holds now, newest first: every entry the reader can read and that is within its
  /// 30 days. Entries the reader refuses are dropped from the file and reported.
  Future<HistoryView> readView() async {
    final now = _clock.now();
    final entries = <HistoryEntry>[];
    final unreadableEntryIds = <String>{};
    for (final stored in await _store.read()) {
      if (HistoryLimits.isExpired(stored.capturedAtOnPhone, now: now)) continue;
      final entry = _entryOf(stored);
      if (entry == null) {
        unreadableEntryIds.add(stored.entryId);
      } else {
        entries.add(entry);
      }
    }
    if (unreadableEntryIds.isNotEmpty) unawaited(_dropUnreadable(unreadableEntryIds));
    return HistoryView(entries);
  }

  /// The view now, and again after every change made through this repository.
  Stream<HistoryView> watchView() {
    late final StreamController<HistoryView> views;
    StreamSubscription<void>? changes;
    Future<void> emit() async {
      try {
        final view = await readView();
        if (!views.isClosed) views.add(view);
      } on Object catch (error, stackTrace) {
        _reportQuietly(error, stackTrace: stackTrace, description: 'Reading History failed');
        if (!views.isClosed) views.addError(error, stackTrace);
      }
    }

    views = StreamController<HistoryView>(
      onListen: () {
        changes = _changes.stream.listen((_) => unawaited(emit()));
        unawaited(emit());
      },
      onCancel: () async {
        await changes?.cancel();
        await views.close();
      },
    );
    return views.stream;
  }

  /// Deletes the entries past their 30 days, and the oldest beyond 50, at start (§3.14).
  Future<void> removeExpiredEntries() async {
    final now = _clock.now().toUtc();
    var hasChanged = false;
    await _store.modify((entries) {
      final kept = _withinLimits(entries, now: now);
      hasChanged = kept.length != entries.length;
      return hasChanged ? kept : entries;
    });
    if (hasChanged) _changes.add(null);
  }

  /// "Clear history": every saved result is deleted from the phone.
  Future<void> clear() async {
    await _store.modify((entries) => entries.isEmpty ? entries : const <StoredHistoryEntry>[]);
    _changes.add(null);
  }

  HistoryEntry? _entryOf(StoredHistoryEntry stored) {
    if (stored.kind != StoredHistoryEntry.resultKind) return null;
    final result = _answerReader.readResult(stored.answer, chosenStationId: stored.chosenStationId);
    if (result == null || result.recognitionId != stored.entryId) return null;
    return HistoryResultEntry(
      entryId: stored.entryId,
      capturedAtOnPhone: stored.capturedAtOnPhone,
      result: result,
    );
  }

  Future<void> _dropUnreadable(Set<String> entryIds) async {
    try {
      await _store.modify((entries) {
        final kept = [
          for (final entry in entries)
            if (!entryIds.contains(entry.entryId)) entry,
        ];
        return kept.length == entries.length ? entries : kept;
      });
      _reportQuietly(
        'History held ${entryIds.length} entries the answer reader refuses; they were dropped',
      );
    } on Object catch (error, stackTrace) {
      _reportQuietly(
        error,
        stackTrace: stackTrace,
        description: 'Dropping unreadable History entries failed',
      );
    }
  }

  /// [entries] without those past 30 days, newest first, at most 50.
  static List<StoredHistoryEntry> _withinLimits(
    List<StoredHistoryEntry> entries, {
    required DateTime now,
  }) {
    final kept = [
      for (final entry in entries)
        if (!HistoryLimits.isExpired(entry.capturedAtOnPhone, now: now)) entry,
    ]..sort((first, second) => second.capturedAtOnPhone.compareTo(first.capturedAtOnPhone));
    return kept.length > HistoryLimits.maximumEntries
        ? kept.sublist(0, HistoryLimits.maximumEntries)
        : kept;
  }

  void _reportQuietly(Object error, {StackTrace? stackTrace, String? description}) {
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
}

/// An answer that does not read as a result, so it was not kept: nothing is saved that History
/// could not show.
final class HistoryAnswerUnreadable implements Exception {
  const HistoryAnswerUnreadable();

  @override
  String toString() => 'HistoryAnswerUnreadable: the answer does not read as a result';
}
