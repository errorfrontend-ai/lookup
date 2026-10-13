import 'outbox_item.dart';
import 'outbox_send_answer.dart';

/// Sends one outbox item of one kind and says what came back (P6 design §3.9). Each feature supplies
/// the sender for its own kind (the station choice's is `StationChoiceSender` in `identify/data`),
/// and the app wires them, so `core/` never imports a feature (§3.8, P6-D4).
///
/// [send] never throws: a failure on the phone is an [OutboxPhoneFault].
abstract interface class OutboxItemSender {
  /// Sends [item] once with [installToken] as `Authorization: Bearer`.
  Future<OutboxSendAnswer> send(OutboxItem item, {required String installToken});
}
