import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// Reads an answer History stored, exactly as the API sent it, into the result it shows (P6 design
/// §3.14): the same reader as a live answer's, so a newer app reads old entries with its newer
/// reader and nothing internal in a stored answer can reach the screen.
///
/// An interface, because that reader is the identify feature's and one feature's data never imports
/// another's (§3.2): `lib/app` implements it with the recognize answer's reader and wires it in.
abstract interface class StoredAnswerReader {
  /// The result [answer] shows: a `MATCH`'s result, or, for a `CHOOSE_STATION`, the candidate of
  /// [chosenStationId]. Null when this version cannot read the answer, or the chosen station is not
  /// among its candidates. Never throws.
  RecognitionResult? readResult(Object? answer, {String? chosenStationId});
}
