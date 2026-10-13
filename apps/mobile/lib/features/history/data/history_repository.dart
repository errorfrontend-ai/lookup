import 'dart:async';

import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/data/history_store.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/domain/history_limits.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';
import 'package:lookup_listener/features/history/domain/history_waiting_clip.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
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
/// - From piece 3 it also keeps what a clip saved with no signal came to (§3.11): a result, a chooser
///   waiting for the listener's choice ([saveAwaitingChoice]), or a clip that will never be
///   identified ([saveNotIdentified]); and its view holds the clips still waiting in the outbox,
///   read through [readWaitingClips], hiding any whose outcome already has an entry.
/// - [clear] empties it ("Clear history", Q7).
/// - [watchView] gives the view again after every write, and after every change of the waiting
///   clips, so "Saved to History" and the History tab follow at once (P6-HISTORY-14).
class HistoryRepository {
  /// [clock] is for tests; the app uses the real one.
  ///
  /// [readWaitingClips] gives the clips waiting in the outbox, and [waitingClipsChanged] fires when
  /// they may have changed; without them History shows no waiting clips.
  HistoryRepository({
    required HistoryStore store,
    required StoredAnswerReader answerReader,
    required ClientErrorReporter clientErrorReporter,
    Clock? clock,
    Future<List<HistoryWaitingClip>> Function()? readWaitingClips,
    Stream<void>? waitingClipsChanged,
  }) : _store = store,
       _answerReader = answerReader,
       _clientErrorReporter = clientErrorReporter,
       _clock = clock ?? Clock(),
       _readWaitingClips = readWaitingClips,
       _waitingClipsChanged = waitingClipsChanged;

  final HistoryStore _store;
  final StoredAnswerReader _answerReader;
  final ClientErrorReporter _clientErrorReporter;
  final Clock _clock;
  final Future<List<HistoryWaitingClip>> Function()? _readWaitingClips;
  final Stream<void>? _waitingClipsChanged;

  final StreamController<void> _changes = StreamController<void>.broadcast(sync: true);

  /// Keeps the result [answer] shows: the API's 200 answer for [recognitionId] exactly as it came
  /// (a `MATCH`, or a `CHOOSE_STATION` with the [chosenStationId] the listener tapped), recorded by
  /// the phone at [capturedAtOnPhone]. A result already kept for [recognitionId] is replaced and
  /// keeps its first capture time, and the saved clip it came from. Throws
  /// [HistoryAnswerUnreadable] when the answer does not read as a result, so nothing is kept that
  /// could not be shown, and the store's own exceptions when it cannot write.
  ///
  /// For a saved clip's `MATCH`, [deferredIdempotencyKey] is the clip's key and [wasNotified] says
  /// a notification will open it (§3.15: only such an entry may be opened by a launch id).
  Future<void> saveResult({
    required String recognitionId,
    required Object? answer,
    required DateTime capturedAtOnPhone,
    String? chosenStationId,
    String? deferredIdempotencyKey,
    bool wasNotified = false,
  }) async {
    final result = _answerReader.readResult(answer, chosenStationId: chosenStationId);
    if (result == null || result.recognitionId != recognitionId) {
      throw const HistoryAnswerUnreadable();
    }
    await _save(
      (earlier, now) => StoredHistoryEntry(
        entryId: recognitionId,
        kind: StoredHistoryEntry.resultKind,
        capturedAtOnPhone: earlier?.capturedAtOnPhone ?? capturedAtOnPhone.toUtc(),
        savedAt: now,
        answer: answer,
        chosenStationId: chosenStationId,
        wasDeferred: earlier?.wasDeferred ?? deferredIdempotencyKey != null,
        deferredIdempotencyKey: earlier?.deferredIdempotencyKey ?? deferredIdempotencyKey,
        wasNotified: (earlier?.wasNotified ?? false) || wasNotified,
        isReported: earlier?.isReported ?? false,
      ),
      entryId: recognitionId,
    );
  }

  /// Keeps a saved clip's `CHOOSE_STATION` answer, waiting for the listener's choice (§3.11, T51).
  /// Throws [HistoryAnswerUnreadable] when the answer does not read as a chooser. A choice already
  /// made for this recognition is never undone by a replay.
  Future<void> saveAwaitingChoice({
    required String recognitionId,
    required Object? answer,
    required DateTime capturedAtOnPhone,
    required String deferredIdempotencyKey,
    required bool wasNotified,
  }) async {
    final candidates = _answerReader.readCandidates(answer);
    if (candidates == null ||
        candidates.any((candidate) => candidate.recognitionId != recognitionId)) {
      throw const HistoryAnswerUnreadable();
    }
    await _save(
      (earlier, now) => earlier?.kind == StoredHistoryEntry.resultKind
          ? earlier!
          : StoredHistoryEntry(
              entryId: recognitionId,
              kind: StoredHistoryEntry.awaitingChoiceKind,
              capturedAtOnPhone: earlier?.capturedAtOnPhone ?? capturedAtOnPhone.toUtc(),
              savedAt: now,
              answer: answer,
              wasDeferred: true,
              deferredIdempotencyKey: deferredIdempotencyKey,
              wasNotified: (earlier?.wasNotified ?? false) || wasNotified,
              isReported: earlier?.isReported ?? false,
            ),
      entryId: recognitionId,
    );
  }

  /// Keeps a saved clip that will never be identified, with why (§3.11): keyed by [entryId], the
  /// recognition id when the server made one, otherwise the clip's own key.
  Future<void> saveNotIdentified({
    required String entryId,
    required DateTime capturedAtOnPhone,
    required DeferredClipNotIdentifiedReason reason,
    required String deferredIdempotencyKey,
    required bool wasNotified,
  }) => _save(
    (earlier, now) => StoredHistoryEntry(
      entryId: entryId,
      kind: StoredHistoryEntry.notIdentifiedKind,
      capturedAtOnPhone: earlier?.capturedAtOnPhone ?? capturedAtOnPhone.toUtc(),
      savedAt: now,
      answer: null,
      notIdentifiedReason: reason.storedName,
      wasDeferred: true,
      deferredIdempotencyKey: deferredIdempotencyKey,
      wasNotified: (earlier?.wasNotified ?? false) || wasNotified,
      isReported: earlier?.isReported ?? false,
    ),
    entryId: entryId,
  );

  /// Whether History holds an entry for [recognitionId] that a notification was posted for: the only
  /// recognition a launch id may open (§3.15).
  Future<bool> wasNotified(String recognitionId) async =>
      (await _store.read()).any((entry) => entry.entryId == recognitionId && entry.wasNotified);

  /// Writes the entry [build] makes (from the entry already kept under [entryId], if any), within
  /// History's limits, and tells the view.
  Future<void> _save(
    StoredHistoryEntry Function(StoredHistoryEntry? earlier, DateTime now) build, {
    required String entryId,
  }) async {
    final now = _clock.now().toUtc();
    await _store.modify((entries) {
      final earlier = entries.where((entry) => entry.entryId == entryId).firstOrNull;
      return _withinLimits([
        build(earlier, now),
        for (final entry in entries)
          if (entry.entryId != entryId) entry,
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
    final readWaitingClips = _readWaitingClips;
    return HistoryView(
      entries,
      waitingClips: readWaitingClips == null ? const [] : await readWaitingClips(),
    );
  }

  /// The view now, and again after every change made through this repository.
  Stream<HistoryView> watchView() {
    late final StreamController<HistoryView> views;
    StreamSubscription<void>? changes;
    StreamSubscription<void>? waitingClipChanges;
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
        waitingClipChanges = _waitingClipsChanged?.listen((_) => unawaited(emit()));
        unawaited(emit());
      },
      onCancel: () async {
        await changes?.cancel();
        await waitingClipChanges?.cancel();
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
  /// Remembers that the listener reported [recognitionId] (P6 design §2.14), so its footer says
  /// "Reported" when it is opened again. Nothing changes when History does not hold it.
  Future<void> markReported(String recognitionId) async {
    await _store.modify(
      (entries) => entries.any((entry) => entry.entryId == recognitionId && !entry.isReported)
          ? [
              for (final entry in entries)
                entry.entryId == recognitionId ? entry.markedReported() : entry,
            ]
          : entries,
    );
    _changes.add(null);
  }

  Future<void> clear() async {
    await _store.modify((entries) => entries.isEmpty ? entries : const <StoredHistoryEntry>[]);
    _changes.add(null);
  }

  HistoryEntry? _entryOf(StoredHistoryEntry stored) {
    switch (stored.kind) {
      case StoredHistoryEntry.resultKind:
        final result = _answerReader.readResult(
          stored.answer,
          chosenStationId: stored.chosenStationId,
        );
        if (result == null || result.recognitionId != stored.entryId) return null;
        return HistoryResultEntry(
          entryId: stored.entryId,
          capturedAtOnPhone: stored.capturedAtOnPhone,
          result: result,
          deferredIdempotencyKey: stored.deferredIdempotencyKey,
          isReported: stored.isReported,
        );
      case StoredHistoryEntry.awaitingChoiceKind:
        final candidates = _answerReader.readCandidates(stored.answer);
        final answer = stored.answer;
        if (candidates == null ||
            answer is! Map<String, Object?> ||
            candidates.any((candidate) => candidate.recognitionId != stored.entryId)) {
          return null;
        }
        return HistoryAwaitingChoiceEntry(
          entryId: stored.entryId,
          capturedAtOnPhone: stored.capturedAtOnPhone,
          candidates: candidates,
          answerBody: answer,
          deferredIdempotencyKey: stored.deferredIdempotencyKey,
        );
      case StoredHistoryEntry.notIdentifiedKind:
        final reason = DeferredClipNotIdentifiedReason.fromStoredName(stored.notIdentifiedReason);
        if (reason == null) return null;
        return HistoryNotIdentifiedEntry(
          entryId: stored.entryId,
          capturedAtOnPhone: stored.capturedAtOnPhone,
          reason: reason,
          deferredIdempotencyKey: stored.deferredIdempotencyKey,
        );
      default:
        return null;
    }
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
