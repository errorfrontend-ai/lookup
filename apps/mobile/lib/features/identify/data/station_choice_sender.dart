import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/outbox/outbox_item_sender.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/core/time/clock.dart';

/// Sends a queued station choice (P6 design §3.9; contract §1.3): `POST
/// /api/v1/recognitions/{recognition_id}/choice` with the install token and exactly
/// `{"station_id": "<uuid>"}` (`RecognitionStationChoiceInput`). The recognition is named by the
/// path, never the body, and the "Remember" tick never leaves the phone.
///
/// The same item always sends the same recognition and station, so a resend after a lost answer
/// is the same choice to the server, which keeps the first one and answers 204 again (contract R12,
/// P6-OUTBOX-03). Each attempt still carries a new `X-Request-Id` from the API client.
final class StationChoiceSender implements OutboxItemSender {
  /// [clock] is for tests; the app uses the real one, to read a `Retry-After` date.
  StationChoiceSender({required ApiClient apiClient, Clock? clock})
    : _apiClient = apiClient,
      _clock = clock ?? Clock();

  final ApiClient _apiClient;
  final Clock _clock;

  /// The body for [item]: its station, and nothing else.
  static Map<String, Object?> bodyFor(StationChoiceItem item) => {'station_id': item.stationId};

  @override
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken}) async {
    if (item is! StationChoiceItem) {
      return OutboxPhoneFault(problem: 'a station choice sender was given ${item.kind.wireName}');
    }
    final answer = await _apiClient.postJson(
      ListenerRoute.choiceFor(item.recognitionId),
      bodyFor(item),
      installToken: installToken,
    );
    return OutboxSendAnswer.fromApiAnswer(answer, now: _clock.now());
  }
}
