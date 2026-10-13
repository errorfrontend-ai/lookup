import 'package:lookup_listener/features/history/domain/stored_answer_reader.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// History's reader of the answers it keeps (P6 design §3.2, §3.14): the recognize answer's own
/// reader, so a saved result is read exactly as a live one is, and a newer app reads old entries
/// with its newer reader. Composed here because History's data never imports the identify
/// feature's (§3.2).
final class HistoryAnswerReader implements StoredAnswerReader {
  const HistoryAnswerReader({RecognizeResponseParser parser = const RecognizeResponseParser()})
    : _parser = parser;

  final RecognizeResponseParser _parser;

  @override
  RecognitionResult? readResult(Object? answer, {String? chosenStationId}) {
    return switch (_parser.read(httpStatus: 200, body: answer)) {
      MatchAnswer(:final result) => chosenStationId == null ? result : null,
      ChooseStationAnswer(:final candidates) =>
        candidates.where((candidate) => candidate.stationId == chosenStationId).firstOrNull,
      _ => null,
    };
  }
}
