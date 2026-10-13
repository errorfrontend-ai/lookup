import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_item_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/core/time/utc_timestamp.dart';

/// Sends a queued button tap (P6 design §3.8, T54; contract §1.5): `POST /engagements` with the
/// recognition, the station, the button's id, when it was first tapped and when this attempt left the
/// phone, and the install token; 204 once the server has it. What each answer does with the item is
/// the outbox's acknowledgement table (a 422 deletes it with a report).
final class EngagementSender implements OutboxItemSender {
  EngagementSender({required ApiClient apiClient, Clock? clock})
    : _apiClient = apiClient,
      _clock = clock ?? Clock();

  final ApiClient _apiClient;
  final Clock _clock;

  /// The body the contract's `RecordEngagementInput` takes: exactly these five fields, `sent_at` new
  /// on every attempt.
  static Map<String, Object?> bodyFor(EngagementItem item, {required DateTime sentAt}) => {
    'recognition_id': item.recognitionId,
    'station_id': item.stationId,
    'action_id': item.actionId,
    'occurred_at': UtcTimestamp.format(item.occurredAt),
    'sent_at': UtcTimestamp.format(sentAt),
  };

  @override
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken}) async {
    if (item is! EngagementItem) {
      return OutboxPhoneFault(problem: 'a tap sender was given ${item.kind.wireName}');
    }
    final answer = await _apiClient.postJson(
      ListenerRoute.engagements,
      bodyFor(item, sentAt: _clock.now()),
      installToken: installToken,
    );
    return OutboxSendAnswer.fromApiAnswer(answer, now: _clock.now());
  }
}
