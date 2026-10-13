import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_item_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/deferred_result_sink.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';

/// Sends a clip the outbox kept (P6 design §3.9 point 10; contract R2): `POST /api/v1/recognize`
/// with `is_deferred` "true", the clip's own key, capture time and hint, a fresh `sent_at`, and the
/// recording read from `outbox/clips/` (P6-OUTBOX-07). The same item always sends the same key, so a
/// resend after a lost answer gets the server's replay of the same recognition (P6-OUTBOX-03).
///
/// What the answer means for the listener is handed to [DeferredResultSink] **before** this returns,
/// so History is written before the outbox deletes the item (§3.9, amended after review): a crash in
/// between leads to a resend, which the server answers with the same recognition id, which History
/// keeps once. The answers it hands on (§3.11):
/// - 200 `MATCH` → a result; 200 `CHOOSE_STATION` → waiting for a choice; 200 `NO_MATCH` and 400
///   `INVALID_AUDIO` → "Not recognised";
/// - 422 `CAPTURE_EXPIRED` → "Not sent within 24 hours — deleted"; 422 `CAPTURE_TIME_INVALID`, and a
///   200 that cannot be read (or has a status this version does not know) → "Couldn't be checked —
///   deleted", the unreadable one also reported, as the acknowledgement table says.
///
/// History failing to keep an outcome is a fault on the phone: the item is deleted and reported
/// rather than sent again and again. Never throws.
final class DeferredClipSender implements OutboxItemSender {
  DeferredClipSender({
    required ApiClient apiClient,
    required OutboxStore store,
    required DeferredResultSink resultSink,
    Clock? clock,
    RecognizeRequestBuilder requestBuilder = const RecognizeRequestBuilder(),
    RecognizeResponseParser responseParser = const RecognizeResponseParser(),
  }) : _apiClient = apiClient,
       _store = store,
       _resultSink = resultSink,
       _clock = clock ?? Clock(),
       _requestBuilder = requestBuilder,
       _responseParser = responseParser;

  final ApiClient _apiClient;
  final OutboxStore _store;
  final DeferredResultSink _resultSink;
  final Clock _clock;
  final RecognizeRequestBuilder _requestBuilder;
  final RecognizeResponseParser _responseParser;

  @override
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken}) async {
    if (item is! DeferredClipItem) {
      return OutboxPhoneFault(problem: 'a deferred clip sender was given ${item.kind.wireName}');
    }
    final List<int>? audioBytes;
    try {
      audioBytes = await _store.readClipAudio(item);
    } on Object catch (error) {
      return OutboxPhoneFault(problem: 'the clip could not be read (${error.runtimeType})');
    }
    if (audioBytes == null) return const OutboxPhoneFault(problem: 'the clip\'s recording is gone');
    final parts = _requestBuilder.buildDeferred(item, audioBytes: audioBytes, sentAt: _clock.now());
    final answer = await _apiClient.postMultipart(
      ListenerRoute.recognize,
      fields: parts.textFields,
      file: ApiMultipartFile(
        fieldName: parts.audioPart.fieldName,
        fileName: parts.audioPart.fileName,
        contentType: parts.audioPart.contentType,
        bytes: parts.audioPart.bytes,
      ),
      installToken: installToken,
    );
    final sendAnswer = OutboxSendAnswer.fromApiAnswer(answer, now: _clock.now());
    if (answer is! ApiAnswerReceived || sendAnswer is! OutboxHttpAnswer) return sendAnswer;

    final read = _responseParser.read(
      httpStatus: answer.status,
      body: switch (answer.body) {
        JsonAnswerBody(:final value) => value,
        NotJsonAnswerBody() => null,
      },
      requestIdHeader: answer.echoedRequestId,
    );
    final outcome = _outcomeOf(item, read);
    if (outcome != null) {
      try {
        await _resultSink.record(outcome);
      } on Object catch (error) {
        return OutboxPhoneFault(
          problem: 'History could not keep the answer (${error.runtimeType})',
        );
      }
    }
    final isUnreadable200 =
        answer.status == 200 && (read is UnreadableAnswer || read is UnknownStatusAnswer);
    if (!isUnreadable200) return sendAnswer;
    return OutboxHttpAnswer(
      httpStatus: 200,
      errorCode: sendAnswer.errorCode,
      apiRequestId: sendAnswer.apiRequestId,
      isBodyUnreadable: true,
    );
  }

  /// What [read] means for the listener, or null for an answer that settles nothing yet (a 409, a
  /// 429, a 5xx…) or one the acknowledgement table deletes with a report and nothing to show.
  DeferredClipOutcome? _outcomeOf(DeferredClipItem item, RecognitionAnswer read) {
    DeferredClipNotIdentified notIdentified(
      DeferredClipNotIdentifiedReason reason, {
      String? recognitionId,
    }) => DeferredClipNotIdentified(
      idempotencyKey: item.idempotencyKey,
      capturedAtOnPhone: item.capturedAt,
      reason: reason,
      recognitionId: recognitionId,
    );
    return switch (read) {
      MatchAnswer(:final result, :final answerBody) => DeferredClipMatched(
        idempotencyKey: item.idempotencyKey,
        capturedAtOnPhone: item.capturedAt,
        recognitionId: result.recognitionId,
        answerBody: answerBody,
      ),
      ChooseStationAnswer(:final recognitionId, :final answerBody) => DeferredClipAwaitingChoice(
        idempotencyKey: item.idempotencyKey,
        capturedAtOnPhone: item.capturedAt,
        recognitionId: recognitionId,
        answerBody: answerBody,
      ),
      NoMatchAnswer(:final recognitionId) => notIdentified(
        DeferredClipNotIdentifiedReason.notRecognised,
        recognitionId: recognitionId,
      ),
      UnreadableAnswer() ||
      UnknownStatusAnswer() => notIdentified(DeferredClipNotIdentifiedReason.couldNotBeChecked),
      ErrorStatusAnswer(httpStatus: 400, errorCode: 'INVALID_AUDIO') => notIdentified(
        DeferredClipNotIdentifiedReason.notRecognised,
      ),
      ErrorStatusAnswer(httpStatus: 422, errorCode: 'CAPTURE_EXPIRED') => notIdentified(
        DeferredClipNotIdentifiedReason.notSentWithin24Hours,
      ),
      ErrorStatusAnswer(httpStatus: 422, errorCode: 'CAPTURE_TIME_INVALID') => notIdentified(
        DeferredClipNotIdentifiedReason.couldNotBeChecked,
      ),
      ErrorStatusAnswer() || NoAnswer() || PhoneFaultAnswer() || CancelledAnswer() => null,
    };
  }
}
