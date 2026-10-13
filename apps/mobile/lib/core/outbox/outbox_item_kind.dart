import 'outbox_item_group.dart';

/// The five kinds of outbox item (P6 design §3.8, contract §3), each in its group. The names are
/// the contract's, as `fixtures/listener-outbox/acknowledgement-rules.json` and the index file write
/// them.
///
/// Piece 1 queues station choices; clips and crash reports arrive in piece 3, reports in piece 4
/// and taps in piece 5. The acknowledgement policy already answers for every kind.
enum OutboxItemKind {
  /// A clip kept with no signal, sent later with `is_deferred` "true".
  deferredClip('DEFERRED_CLIP', OutboxItemGroup.clips),

  /// The listener's choice in "Which station?" (`POST /recognitions/{id}/choice`).
  stationChoice('STATION_CHOICE', OutboxItemGroup.followUps),

  /// A button tap on a result (`POST /engagements`).
  engagement('ENGAGEMENT', OutboxItemGroup.followUps),

  /// "Report this" (`POST /recognitions/{id}/report`).
  recognitionReport('RECOGNITION_REPORT', OutboxItemGroup.followUps),

  /// A crash report that could not be sent (`POST /client-errors`).
  clientErrorReport('CLIENT_ERROR_REPORT', OutboxItemGroup.crashReports);

  const OutboxItemKind(this.wireName, this.group);

  /// The contract's name, e.g. `STATION_CHOICE`.
  final String wireName;

  /// The server allowance the kind uses.
  final OutboxItemGroup group;

  /// The kind named [wireName], or null for a name this version does not know.
  static OutboxItemKind? fromWireName(Object? wireName) {
    for (final kind in values) {
      if (kind.wireName == wireName) return kind;
    }
    return null;
  }
}
