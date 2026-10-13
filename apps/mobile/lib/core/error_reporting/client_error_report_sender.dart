import '../network/api_client.dart';
import '../outbox/outbox_item_sender.dart';
import '../outbox/outbox_send_answer.dart';
import '../outbox/outbox_store.dart';
import '../time/clock.dart';

/// Sends a crash report the outbox kept because it got no answer (P6 design §3.20;
/// P6-ERRORREPORTING-05): `POST /api/v1/client-errors` with the fields the reporter already scrubbed
/// and `occurredAt`, the phone's time of the error, under the report's own id as `X-Request-Id` on
/// every attempt (P6-D43), so the API's log shows one report even when an answer was lost. It never
/// carries the install token. Never throws.
final class ClientErrorReportSender implements OutboxItemSender {
  ClientErrorReportSender({required ApiClient apiClient, Clock? clock})
    : _apiClient = apiClient,
      _clock = clock ?? Clock();

  final ApiClient _apiClient;
  final Clock _clock;

  /// The body for [item]: its stored fields and `occurredAt`.
  static Map<String, Object?> bodyFor(ClientErrorReportItem item) => {
    ...item.fields,
    'occurredAt': item.occurredAt.toUtc().toIso8601String(),
  };

  @override
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken}) async {
    if (item is! ClientErrorReportItem) {
      return OutboxPhoneFault(problem: 'a crash report sender was given ${item.kind.wireName}');
    }
    final answer = await _apiClient.postJson(
      ListenerRoute.clientErrors,
      bodyFor(item),
      requestId: item.reportId,
    );
    return OutboxSendAnswer.fromApiAnswer(answer, now: _clock.now());
  }
}
