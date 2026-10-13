import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_item_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// Sends a queued "Report this" (P6 design §2.14; contract §1.6): `POST
/// /recognitions/{recognition_id}/report` with `{"station_id": …, "reason": …}` and the install
/// token, 204 once the server has it. What each answer does with the item is the outbox's
/// acknowledgement table (a 422 `STATION_ALREADY_CHOSEN` deletes it with a report).
final class RecognitionReportSender implements OutboxItemSender {
  RecognitionReportSender({required ApiClient apiClient, Clock? clock})
    : _apiClient = apiClient,
      _clock = clock ?? Clock();

  final ApiClient _apiClient;
  final Clock _clock;

  /// The body the contract's `ReportRecognitionInput` takes: exactly these two fields.
  static Map<String, Object?> bodyFor(RecognitionReportItem item) => {
    'station_id': item.stationId,
    'reason': item.reason,
  };

  @override
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken}) async {
    if (item is! RecognitionReportItem) {
      return OutboxPhoneFault(problem: 'a report sender was given ${item.kind.wireName}');
    }
    final answer = await _apiClient.postJson(
      ListenerRoute.reportFor(item.recognitionId),
      bodyFor(item),
      installToken: installToken,
    );
    return OutboxSendAnswer.fromApiAnswer(answer, now: _clock.now());
  }
}
