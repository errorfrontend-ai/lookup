import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

import '../support/history_fixtures.dart';

const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// History reads its stored answers with the recognize answer's own reader (P6 design §3.2, §3.14).
void main() {
  const reader = HistoryAnswerReader();

  test('a MATCH answer reads as its result, card included', () {
    final result = reader.readResult(HistoryFixtures.answer('valid/match-campaign'))!;
    expect(result.recognitionId, HistoryFixtures.fixtureRecognitionId);
    expect(result.stationName, 'Station A');
    expect(result.kind, RecognitionResultKind.campaign);
    expect(result.card.shownActions, hasLength(4));
  });

  test('a CHOOSE_STATION answer reads as the chosen candidate, and only with one', () {
    final answer = HistoryFixtures.answer('valid/choose-station');
    final chosen = reader.readResult(answer, chosenStationId: _stationBId)!;
    expect(chosen.stationName, 'Station B');
    expect(reader.readResult(answer), isNull, reason: 'no station chosen');
    expect(
      reader.readResult(answer, chosenStationId: '0192a6c4-1111-4000-8000-000000000009'),
      isNull,
      reason: 'not one of its stations',
    );
  });

  test('anything else reads as nothing, and never throws', () {
    for (final answer in <Object?>[
      HistoryFixtures.answer('valid/no-match'),
      HistoryFixtures.answer('invalid/match-without-result'),
      HistoryFixtures.answer('invalid/choose-station-five-candidates'),
      null,
      'not an answer',
      const <String, Object?>{},
    ]) {
      expect(reader.readResult(answer), isNull, reason: '$answer');
    }
    expect(
      reader.readResult(
        HistoryFixtures.answer('valid/match-campaign'),
        chosenStationId: _stationBId,
      ),
      isNull,
      reason: 'a match has no station to choose',
    );
  });
}
