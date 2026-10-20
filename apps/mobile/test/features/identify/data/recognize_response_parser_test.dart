import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/send_policy.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

import '../../../support/contract_fixtures.dart';

const RecognizeResponseParser _parser = RecognizeResponseParser();
const String _fixtureRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/// What each recognize-response fixture leads to (§4.4). Every fixture in the folders must be named
/// here, so a new fixture fails the test until someone decides what the app does with it.
const Map<String, String> _expectedValidStates = {
  // ADR-005: the ad was recognised but its result waits for the listener's account; nothing of the ad is sent.
  'account-required': 'account required',
  'account-required-deferred': 'account required',
  // The chooser (P6 design T19′): every candidate, in the answer's order.
  'choose-station': 'chooser: Station A, Station B',
  'choose-station-deferred': 'chooser: Station A, Station B',
  'choose-station-four-candidates': 'chooser: Station A, Station B, Station C, Station D',
  'choose-station-out-of-window': 'chooser: Station A, Station B, all default cards',
  'choose-station-three-candidates': 'chooser: Station A, Station B, Station C',
  'match-campaign': 'matched',
  'match-campaign-station-b': 'matched',
  'match-client-default': 'fallback',
  'match-station-without-city': 'matched',
  'match-with-images': 'matched',
  'no-match': 'no match',
  'no-match-deferred-with-offset': 'no match',
};

const Map<String, String> _expectedInvalidStates = {
  // Anything beyond the five fields of a withheld result is never read: the gate shows nothing of it.
  'account-required-with-result': 'account required',
  'account-required-with-station-name': 'account required',
  // Statuses the app does not know.
  'ambiguous-status': 'newer app needed',
  'match-found-status': 'newer app needed',
  // Internal fields: ignored, never shown, so the card reads exactly as match-campaign's.
  'audio-asset-number': 'matched, read as match-campaign',
  'match-scores': 'matched, read as match-campaign',
  'station-engagement-limit': 'matched, read as match-campaign',
  'tenant-id': 'matched, read as match-campaign',
  // The image is dropped and the card shown without it (match-campaign has no banner).
  'header-image-not-https': 'matched, read as match-campaign',
  // An unknown kind reads as a campaign.
  'unknown-result-kind': 'matched, read as match-campaign',
  // Fields the app does not use: read normally.
  'missing-is-deferred': 'no match',
  'no-match-with-candidates': 'no match',
  'no-match-with-result': 'no match',
  'recognition-id-version-4': 'no match',
  // A match the screen cannot show.
  'match-without-result': 'server failure, reported',
  // A campaign id in a candidate is never read: the chooser shows nothing internal.
  'candidate-with-campaign-id': 'chooser: Station A, Station B',
  // Choosers the sheet cannot show (T19″): a server failure, reported, and nothing from the broken
  // candidates is ever shown.
  'choose-station-five-candidates': 'server failure, reported',
  'choose-station-one-candidate': 'server failure, reported',
  'choose-station-same-station-twice': 'server failure, reported',
  'choose-station-with-result': 'server failure, reported',
  // A missing city reads as none, so the card is match-campaign's without "· Lusaka".
  'station-without-city-field': 'matched, read as match-campaign without its city',
};

/// Where each error envelope leads on a clip's first send (§3.11).
const Map<String, String> _expectedEnvelopeOutcomes = {
  'capture-expired': 'server failure, reported',
  'capture-time-invalid': 'server failure, reported',
  'forbidden': 'server failure, reported',
  'install-token-invalid': 'register again and resend, clip kept',
  'internal': 'server failure',
  'invalid-audio': 'recording unusable, reported',
  'payload-too-large': 'server failure, reported',
  'rate-limited': 'kept for later: too many tries',
  'recognition-busy': 'busy 10 s, clip kept',
  'recognition-in-progress': 'wait 3 s and resend, clip kept',
  'recognition-timeout': 'busy 5 s, clip kept',
  'service-unavailable': 'busy 10 s, clip kept',
  'unsupported-media-type': 'server failure, reported',
  'validation-failed': 'server failure, reported',
  // Answers of the routes the next pieces add; on a clip's send they are an app this old's cue to
  // update (426), or the API refusing what was sent.
  'action-not-on-card': 'server failure, reported',
  'app-update-required': 'please update the app',
  'not-found': 'server failure, reported',
  'station-already-chosen': 'server failure, reported',
  'station-not-a-candidate': 'server failure, reported',
  // The listener account's own refusals (ADR-005) belong to its routes; on a clip's send they are the API
  // refusing what was sent, or a wait.
  'account-age-too-young': 'server failure, reported',
  'account-ticket-not-valid': 'server failure, reported',
  'already-signed-in': 'wait 3 s and resend, clip kept',
  'listener-code-expired': 'server failure, reported',
  'listener-code-incorrect': 'server failure, reported',
  'listener-code-locked': 'server failure, reported',
  'resend-too-soon': 'kept for later: too many tries',
};

RecognitionAnswer _readResponseFixture(NamedFixture fixture) =>
    _parser.read(httpStatus: 200, body: (fixture.content as Map<String, Object?>)['response']);

RecognitionOutcome _decide(RecognitionAnswer answer, {SendPolicy policy = const SendPolicy()}) =>
    policy.decide(answer, reportRequestId: _reportRequestId);

/// The outcome in words, for comparing with the tables above.
String _describe(RecognitionOutcome outcome) {
  final reported = outcome is FinishedOutcome && outcome.problemReport != null ? ', reported' : '';
  return switch (outcome) {
    BusyOutcome(:final retryDelaySeconds) => 'busy $retryDelaySeconds s, clip kept',
    WaitAndResendOutcome(:final waitSeconds) => 'wait $waitSeconds s and resend, clip kept',
    RegisterAgainOutcome() => 'register again and resend, clip kept',
    SaveForLaterOutcome(:final reason) =>
      'kept for later: ${switch (reason) {
        SavedClipReason.noConnection => 'no connection',
        SavedClipReason.busy => 'busy',
        SavedClipReason.tooManyTries => 'too many tries',
      }}',
    FinishedOutcome(:final nextState) => switch (nextState) {
      MatchedState() => 'matched',
      FallbackState() => 'fallback',
      NoMatchState() => 'no match',
      AccountRequiredState() => 'account required',
      ChooseStationState(:final candidates, :final areAllCandidatesDefaultCards) =>
        'chooser: ${candidates.map((candidate) => candidate.stationName).join(', ')}'
            '${areAllCandidatesDefaultCards ? ', all default cards' : ''}',
      ErrorState(failure: NewerAppNeededFailure()) => 'newer app needed',
      ErrorState(failure: AppUpdateRequiredFailure()) => 'please update the app',
      ErrorState(failure: ServerFailure()) => 'server failure$reported',
      ErrorState(failure: RecordingUnusableFailure()) => 'recording unusable$reported',
      ErrorState(failure: PhoneFailure()) => 'phone failure$reported',
      _ => 'unexpected $nextState',
    },
  };
}

/// Everything about a result the screen can show, so two readings can be compared whole.
List<Object?> _visibleReading(RecognitionResult result) => [
  result.kind,
  result.recognitionId,
  result.stationId,
  result.stationName,
  result.stationFrequencyLabel,
  result.stationCity,
  result.clientName,
  result.title,
  _imageReading(result.stationLogo),
  _imageReading(result.clientLogo),
  _imageReading(result.headerImage),
  result.card.showsUpdateAppHint,
  result.card.skippedUnknownTypeCount,
  result.card.skippedInvalidCount,
  result.card.moreOptionsActions.length,
  for (final action in result.card.shownActions) _actionReading(action),
];

String? _imageReading(PublicImage? image) => image == null
    ? null
    : '${image.address} ${image.widthPixels}x${image.heightPixels} ${image.sizeBytes} bytes';

String _actionReading(UiAction action) {
  final common = '${action.id} "${action.label}" ${action.style.wireName}';
  return switch (action) {
    CallUiAction(:final phoneNumberE164) => 'call $common $phoneNumberE164',
    WhatsAppUiAction(:final phoneNumberE164, :final prefilledText) =>
      'whatsapp $common $phoneNumberE164 $prefilledText',
    MapUiAction(:final latitude, :final longitude, :final placeName) =>
      'map $common $latitude,$longitude $placeName',
    LinkUiAction(:final link) => 'link $common $link',
  };
}

void main() {
  final validResponses = ContractFixtures.readFolder('recognition/recognize-response/valid');
  final invalidResponses = ContractFixtures.readFolder('recognition/recognize-response/invalid');
  final envelopes = ContractFixtures.readFolder('errors/envelopes');
  final campaignReading = _visibleReading(
    (_readResponseFixture(validResponses.firstWhere((fixture) => fixture.name == 'match-campaign'))
            as MatchAnswer)
        .result,
  );

  test(
    'the loader finds 14 valid and 21 invalid responses and 26 envelopes, each with an expectation',
    () {
      expect(validResponses, hasLength(14));
      expect(invalidResponses, hasLength(21));
      expect(envelopes, hasLength(26));
      expect(
        validResponses.map((fixture) => fixture.name).toSet(),
        _expectedValidStates.keys.toSet(),
      );
      expect(
        invalidResponses.map((fixture) => fixture.name).toSet(),
        _expectedInvalidStates.keys.toSet(),
      );
      expect(
        envelopes.map((fixture) => fixture.name).toSet(),
        _expectedEnvelopeOutcomes.keys.toSet(),
      );
    },
  );

  group('ACCOUNT_REQUIRED (ADR-005)', () {
    test('reads the recognition id and the capture time, and keeps the answer exactly as it came', () {
      final fixture = validResponses.firstWhere((fixture) => fixture.name == 'account-required-deferred');
      final answer = _readResponseFixture(fixture) as AccountRequiredAnswer;
      expect(answer.recognitionId, '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70');
      expect(answer.capturedAt, DateTime.utc(2026, 10, 7, 4, 30));
      expect(answer.answerBody, (fixture.content as Map<String, Object?>)['response']);
      expect(answer.apiRequestId, _fixtureRequestId);
    });

    for (final badId in <Object?>[null, '', 'not-an-id', '0199b2c4-5a6e-4c3d-8f10-2b3c4d5e6f70', 7]) {
      test('a recognition id of $badId cannot be reopened: unreadable, so a server failure that is reported', () {
        final answer = _parser.read(
          httpStatus: 200,
          body: {
            'status': 'ACCOUNT_REQUIRED',
            'recognition_id': ?badId,
            'request_id': _fixtureRequestId,
            'is_deferred': false,
            'captured_at': '2026-10-07T06:30:00Z',
          },
        );
        expect(answer, isA<UnreadableAnswer>());
        expect(_describe(_decide(answer)), 'server failure, reported');
      });
    }

    test('never reads anything of the ad, even if a server sent it', () {
      final fixture = invalidResponses.firstWhere((fixture) => fixture.name == 'account-required-with-result');
      final answer = _readResponseFixture(fixture);
      expect(answer, isA<AccountRequiredAnswer>());
      expect(_describe(_decide(answer)), 'account required');
    });
  });

  group('recognize-response/valid', () {
    for (final fixture in validResponses) {
      test('${fixture.name} → ${_expectedValidStates[fixture.name]}', () {
        final answer = _readResponseFixture(fixture);
        expect(_describe(_decide(answer)), _expectedValidStates[fixture.name]);
        expect((answer as ReceivedAnswer).apiRequestId, _fixtureRequestId);
      });
    }

    test('match-campaign gives the station, the client, the title and the four buttons', () {
      final answer = _readResponseFixture(
        validResponses.firstWhere((fixture) => fixture.name == 'match-campaign'),
      );
      final result = (answer as MatchAnswer).result;
      expect(result.kind, RecognitionResultKind.campaign);
      expect(result.stationId, '0192a6c4-1111-4000-8000-000000000001');
      expect(result.stationName, 'Station A');
      expect(result.stationFrequencyLabel, '98.1 FM');
      expect(result.clientName, 'Brand A');
      expect(result.title, 'Summer service offer');
      expect(result.card.visibleActions.map((action) => action.label), [
        'Call us',
        'WhatsApp us',
        'Find our shop',
        'See the menu',
      ]);
      expect(result.card.showsUpdateAppHint, isFalse);
      expect(result.stationLogo, isNull);
      expect(result.clientLogo, isNull);
      expect(result.headerImage, isNull);
    });

    test('match-with-images reads the banner and the station logo with their sizes', () {
      final answer = _readResponseFixture(
        validResponses.firstWhere((fixture) => fixture.name == 'match-with-images'),
      );
      final result = (answer as MatchAnswer).result;
      expect(
        _imageReading(result.headerImage),
        'https://images.lookup.invalid/header/abc.webp 720x360 48000 bytes',
      );
      expect(
        _imageReading(result.stationLogo),
        'https://images.lookup.invalid/logo/station-a.webp 96x96 4200 bytes',
      );
      expect(result.clientLogo, isNull);
    });

    test(
      'choose-station: the recognition, the capture time and each station with its own card',
      () {
        final answer =
            _readResponseFixture(
                  validResponses.firstWhere((fixture) => fixture.name == 'choose-station'),
                )
                as ChooseStationAnswer;
        expect(answer.recognitionId, '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70');
        expect(answer.capturedAt, DateTime.utc(2026, 10, 7, 6, 30));
        expect(answer.apiRequestId, _fixtureRequestId);
        expect(
          [
            for (final candidate in answer.candidates)
              [
                candidate.recognitionId,
                candidate.stationId,
                candidate.stationName,
                candidate.stationFrequencyLabel,
                candidate.stationCity,
                candidate.kind,
                candidate.card.shownActions.first.id,
                candidate.card.shownActions.first.label,
              ],
          ],
          [
            [
              '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
              '0192a6c4-1111-4000-8000-000000000001',
              'Station A',
              '98.1 FM',
              'Lusaka',
              RecognitionResultKind.campaign,
              '0192a6c4-0000-4000-8000-000000000001',
              'Call us',
            ],
            [
              '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
              '0192a6c4-1111-4000-8000-000000000002',
              'Station B',
              '104.3 FM',
              'Kitwe',
              RecognitionResultKind.campaign,
              '0192a6c4-0000-4000-8000-000000000011',
              'Call us',
            ],
          ],
        );
        expect(() => answer.candidates.add(answer.candidates.first), throwsUnsupportedError);
      },
    );

    test('a station with a null city reads with none, in a result and in a candidate', () {
      final match =
          _readResponseFixture(
                validResponses.firstWhere(
                  (fixture) => fixture.name == 'match-station-without-city',
                ),
              )
              as MatchAnswer;
      expect(match.result.stationName, 'Station D');
      expect(match.result.stationCity, isNull);
      final four =
          _readResponseFixture(
                validResponses.firstWhere(
                  (fixture) => fixture.name == 'choose-station-four-candidates',
                ),
              )
              as ChooseStationAnswer;
      expect(four.candidates.map((candidate) => candidate.stationCity), [
        'Lusaka',
        'Kitwe',
        'Ndola',
        null,
      ]);
    });

    test('a match keeps its recognition id and the answer\'s capture time, with its offset', () {
      final match =
          _readResponseFixture(
                validResponses.firstWhere((fixture) => fixture.name == 'match-campaign'),
              )
              as MatchAnswer;
      expect(match.result.recognitionId, '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70');
      expect(match.capturedAt, DateTime.utc(2026, 10, 7, 6, 30));
      final noMatch =
          _readResponseFixture(
                validResponses.firstWhere(
                  (fixture) => fixture.name == 'no-match-deferred-with-offset',
                ),
              )
              as NoMatchAnswer;
      expect(noMatch.recognitionId, '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70');
      expect(noMatch.capturedAt, DateTime.utc(2026, 10, 7, 4, 30));
    });

    test('match-client-default is the advertiser default card, with the same buttons', () {
      final answer = _readResponseFixture(
        validResponses.firstWhere((fixture) => fixture.name == 'match-client-default'),
      );
      final result = (answer as MatchAnswer).result;
      expect(result.kind, RecognitionResultKind.clientDefault);
      expect(_visibleReading(result).skip(1), campaignReading.skip(1));
    });
  });

  group('recognize-response/invalid: never throws, never shows what it should not', () {
    for (final fixture in invalidResponses) {
      final expected = _expectedInvalidStates[fixture.name]!;
      test('${fixture.name} → $expected', () {
        final answer = _readResponseFixture(fixture);
        final outcome = _decide(answer);
        if (expected == 'matched, read as match-campaign') {
          expect(_describe(outcome), 'matched');
          expect(_visibleReading((answer as MatchAnswer).result), campaignReading);
        } else if (expected == 'matched, read as match-campaign without its city') {
          expect(_describe(outcome), 'matched');
          final result = (answer as MatchAnswer).result;
          expect(result.stationCity, isNull);
          expect(_visibleReading(result), [
            ...campaignReading.take(5),
            null,
            ...campaignReading.skip(6),
          ]);
        } else {
          expect(_describe(outcome), expected);
        }
      });
    }

    test('candidate-with-campaign-id: the chooser holds nothing but what a result holds', () {
      final answer =
          _readResponseFixture(
                invalidResponses.firstWhere(
                  (fixture) => fixture.name == 'candidate-with-campaign-id',
                ),
              )
              as ChooseStationAnswer;
      final valid =
          _readResponseFixture(
                validResponses.firstWhere((fixture) => fixture.name == 'choose-station'),
              )
              as ChooseStationAnswer;
      expect(answer.candidates.map(_visibleReading), valid.candidates.map(_visibleReading));
      expect(answer.candidates.toString(), isNot(contains('campaign')));
    });

    test('recognition-id-version-4: a no match with no recognition id, which changes nothing', () {
      final answer =
          _readResponseFixture(
                invalidResponses.firstWhere(
                  (fixture) => fixture.name == 'recognition-id-version-4',
                ),
              )
              as NoMatchAnswer;
      expect(answer.recognitionId, isNull);
    });

    test('match-without-result is reported with the API id, which gives the code', () {
      final outcome = _decide(
        _readResponseFixture(
          invalidResponses.firstWhere((fixture) => fixture.name == 'match-without-result'),
        ),
      );
      expect(
        outcome.nextState,
        const ErrorState(failure: ServerFailure(requestId: _fixtureRequestId)),
      );
      final problemReport = (outcome as FinishedOutcome).problemReport!;
      expect(problemReport.relatedRequestId, _fixtureRequestId);
      expect(problemReport.summary, contains('MATCH without a readable result'));
    });
  });

  group('errors/envelopes: each leads to its row of §3.11 through SendPolicy', () {
    for (final fixture in envelopes) {
      final content = fixture.content as Map<String, Object?>;
      final httpStatus = content['http_status']! as int;
      final retryAfterSeconds = content['retry_after_seconds'] as int?;
      final envelope = (content['body']! as Map<String, Object?>)['error']! as Map<String, Object?>;

      test('${fixture.name} (HTTP $httpStatus) → ${_expectedEnvelopeOutcomes[fixture.name]}', () {
        final answer = _parser.read(
          httpStatus: httpStatus,
          body: content['body'],
          retryAfterSeconds: retryAfterSeconds,
        );
        expect(answer, isA<ErrorStatusAnswer>());
        final errorAnswer = answer as ErrorStatusAnswer;
        expect(errorAnswer.httpStatus, httpStatus);
        expect(errorAnswer.errorCode, envelope['code']);
        expect(errorAnswer.apiRequestId, envelope['request_id']);
        expect(errorAnswer.retryAfterSeconds, retryAfterSeconds);

        final outcome = _decide(answer);
        expect(_describe(outcome), _expectedEnvelopeOutcomes[fixture.name]);

        // The code panel's id is the envelope's request id whenever the screen shows one.
        final nextState = outcome.nextState;
        if (nextState is ErrorState && nextState.failure.referenceCodeRequestId != null) {
          expect(nextState.failure.referenceCodeRequestId, envelope['request_id']);
        }

        // The API's message reaches neither the state nor the crash report (S4-D13).
        final message = envelope['message']! as String;
        expect(nextState.toString(), isNot(contains(message)));
        if (outcome is FinishedOutcome) {
          expect(outcome.problemReport?.summary ?? '', isNot(contains(message)));
          expect(outcome.problemReport?.relatedRequestId, anyOf(isNull, envelope['request_id']));
        }
      });
    }

    test('validation-failed keeps the refused fields for the report, never the message', () {
      final content =
          envelopes.firstWhere((fixture) => fixture.name == 'validation-failed').content
              as Map<String, Object?>;
      final answer = _parser.read(httpStatus: 400, body: content['body']) as ErrorStatusAnswer;
      expect(answer.fieldProblems, const [
        FieldProblem(path: 'captured_at', code: 'invalid_format'),
        FieldProblem(path: 'sent_at', code: 'invalid_format'),
      ]);
      expect(
        (_decide(answer) as FinishedOutcome).problemReport!.summary,
        contains('captured_at invalid_format, sent_at invalid_format'),
      );
    });

    test(
      'busy envelopes four times in a row are kept for later (T21′); 409 three times and 401 twice end in Error',
      () {
        RecognitionOutcome sendRepeatedly(String fixtureName, int times) {
          final content =
              envelopes.firstWhere((fixture) => fixture.name == fixtureName).content
                  as Map<String, Object?>;
          final answer = _parser.read(
            httpStatus: content['http_status']! as int,
            body: content['body'],
            retryAfterSeconds: content['retry_after_seconds'] as int?,
          );
          var policy = const SendPolicy();
          late RecognitionOutcome outcome;
          for (var send = 0; send < times; send++) {
            outcome = _decide(answer, policy: policy);
            policy = switch (outcome) {
              BusyOutcome(:final nextPolicy) => nextPolicy,
              WaitAndResendOutcome(:final nextPolicy) => nextPolicy,
              RegisterAgainOutcome(:final nextPolicy) => nextPolicy,
              _ => policy,
            };
          }
          return outcome;
        }

        for (final busyFixture in [
          'recognition-busy',
          'recognition-timeout',
          'service-unavailable',
        ]) {
          expect(
            _describe(sendRepeatedly(busyFixture, 3)),
            startsWith('busy'),
            reason: busyFixture,
          );
          // T21′: the fourth busy answer keeps the clip for later.
          expect(
            _describe(sendRepeatedly(busyFixture, 4)),
            'kept for later: busy',
            reason: busyFixture,
          );
        }
        expect(_describe(sendRepeatedly('recognition-in-progress', 2)), startsWith('wait'));
        expect(_describe(sendRepeatedly('recognition-in-progress', 3)), 'server failure');
        expect(_describe(sendRepeatedly('install-token-invalid', 2)), 'server failure, reported');
      },
    );
  });

  group('the API id of an answer (§3.8)', () {
    final body = {
      'error': {'code': 'INTERNAL', 'message': 'x', 'request_id': _fixtureRequestId},
    };
    const headerRequestId = '1d4e7a2b-3c5f-4a6e-8b9d-0e1f2a3b4c5d';

    test('is the X-Request-Id header when it is a UUID, in lower case', () {
      final answer = _parser.read(
        httpStatus: 500,
        body: body,
        requestIdHeader: headerRequestId.toUpperCase(),
      );
      expect((answer as ReceivedAnswer).apiRequestId, headerRequestId);
    });

    test('else the body request id, from the error envelope or the recognize answer', () {
      for (final requestIdHeader in [
        null,
        '',
        'not-a-uuid',
        '$headerRequestId, $headerRequestId',
      ]) {
        final answer = _parser.read(httpStatus: 500, body: body, requestIdHeader: requestIdHeader);
        expect((answer as ReceivedAnswer).apiRequestId, _fixtureRequestId);
      }
      final noMatch = _parser.read(
        httpStatus: 200,
        body: {'status': 'NO_MATCH', 'request_id': _fixtureRequestId},
      );
      expect((noMatch as ReceivedAnswer).apiRequestId, _fixtureRequestId);
    });

    test('else none: a body id that is not a UUID gives no code', () {
      for (final requestId in ['ingest-sweep-$_fixtureRequestId', '', ' $_fixtureRequestId ', 42]) {
        final answer = _parser.read(
          httpStatus: 500,
          body: {
            'error': {'code': 'INTERNAL', 'request_id': requestId},
          },
        );
        expect((answer as ReceivedAnswer).apiRequestId, isNull, reason: '$requestId');
        expect(_describe(_decide(answer)), 'phone failure, reported');
      }
    });
  });

  group('answers that are not what the contract says', () {
    test('a proxy page with 502 and no id is busy; with 500 it is a reported phone failure', () {
      const page = '<html><body>Bad gateway</body></html>';
      final busy = _parser.readText(httpStatus: 502, bodyText: page);
      expect(busy, isA<ErrorStatusAnswer>());
      expect((busy as ErrorStatusAnswer).errorCode, isNull);
      expect(busy.apiRequestId, isNull);
      expect(_describe(_decide(busy)), 'busy 10 s, clip kept');
      final failed = _parser.readText(httpStatus: 500, bodyText: page);
      expect(_describe(_decide(failed)), 'phone failure, reported');
    });

    test('a 200 whose body is not a JSON object is a server failure, reported', () {
      for (final bodyText in ['', 'not json', '[]', '"MATCH"', '42', 'null', '{"status":']) {
        final answer = _parser.readText(
          httpStatus: 200,
          bodyText: bodyText,
          requestIdHeader: _fixtureRequestId,
        );
        expect(answer, isA<UnreadableAnswer>(), reason: bodyText);
        expect(_describe(_decide(answer)), 'server failure, reported', reason: bodyText);
      }
    });

    test('a 200 with no status, or a status that is not text, cannot be read', () {
      for (final body in <Object?>[
        <String, Object?>{},
        {'status': null},
        {'status': 1},
        {'status': true},
        {
          'error': {'code': 'INTERNAL', 'request_id': _fixtureRequestId},
        },
      ]) {
        expect(_parser.read(httpStatus: 200, body: body), isA<UnreadableAnswer>(), reason: '$body');
      }
    });

    test('a status is matched exactly: "match" is a status the app does not know', () {
      expect(_parser.read(httpStatus: 200, body: {'status': 'match'}), isA<UnknownStatusAnswer>());
    });

    group('a MATCH result needs every field the screen shows', () {
      Map<String, Object?> campaignResponse() =>
          jsonDecode(
                jsonEncode(
                  (validResponses.firstWhere((fixture) => fixture.name == 'match-campaign').content
                      as Map<String, Object?>)['response'],
                ),
              )
              as Map<String, Object?>;
      Map<String, Object?> resultOf(Map<String, Object?> response) =>
          response['result']! as Map<String, Object?>;
      Map<String, Object?> partOf(Map<String, Object?> response, String name) =>
          resultOf(response)[name]! as Map<String, Object?>;

      final breakages = <String, void Function(Map<String, Object?> response)>{
        'no station': (response) => resultOf(response).remove('station'),
        'no station id': (response) => partOf(response, 'station').remove('id'),
        'a station name that is blank': (response) => partOf(response, 'station')['name'] = '   ',
        'a frequency label that is not text': (response) =>
            partOf(response, 'station')['frequency_label'] = 98.1,
        'no client': (response) => resultOf(response)['client'] = null,
        'a client name that is empty': (response) => partOf(response, 'client')['name'] = '',
        'no title': (response) => resultOf(response).remove('title'),
        'a blank title': (response) => resultOf(response)['title'] = '\t\n',
        'no card': (response) => resultOf(response).remove('card'),
        'a card that is a list': (response) => resultOf(response)['card'] = <Object?>[],
        'a result that is text': (response) => response['result'] = 'Brand A',
      };
      breakages['no recognition id'] = (response) => response.remove('recognition_id');
      breakages['a recognition id of version 4'] = (response) =>
          response['recognition_id'] = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
      breakages['a recognition id in capitals'] = (response) =>
          response['recognition_id'] = '0199B2C4-5A6E-7C3D-8F10-2B3C4D5E6F70';
      for (final MapEntry(key: breakage, value: breakResponse) in breakages.entries) {
        test('$breakage → server failure, reported', () {
          final response = campaignResponse();
          breakResponse(response);
          final answer = _parser.read(httpStatus: 200, body: response);
          expect(answer, isA<UnreadableAnswer>());
          expect(_describe(_decide(answer)), 'server failure, reported');
        });
      }

      test('a card too new for this app is still a match, with no buttons and the update hint', () {
        final response = campaignResponse();
        partOf(response, 'card')['schema_version'] = 2;
        final result = (_parser.read(httpStatus: 200, body: response) as MatchAnswer).result;
        expect(result.card.shownActions, isEmpty);
        expect(result.card.showsUpdateAppHint, isTrue);
      });

      test('a missing kind reads as a campaign', () {
        final response = campaignResponse();
        resultOf(response).remove('kind');
        final result = (_parser.read(httpStatus: 200, body: response) as MatchAnswer).result;
        expect(result.kind, RecognitionResultKind.campaign);
      });
    });

    group('a CHOOSE_STATION needs its recognition id and 2 to 4 readable stations (T19″)', () {
      Map<String, Object?> chooserResponse() =>
          jsonDecode(
                jsonEncode(
                  (validResponses.firstWhere((fixture) => fixture.name == 'choose-station').content
                      as Map<String, Object?>)['response'],
                ),
              )
              as Map<String, Object?>;
      List<Object?> candidatesOf(Map<String, Object?> response) =>
          response['candidates']! as List<Object?>;

      final breakages = <String, void Function(Map<String, Object?> response)>{
        'no recognition id': (response) => response.remove('recognition_id'),
        'a recognition id of version 4': (response) =>
            response['recognition_id'] = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
        'no candidates': (response) => response.remove('candidates'),
        'candidates that are not a list': (response) => response['candidates'] = 'Station A',
        'an empty list': (response) => response['candidates'] = <Object?>[],
        'one readable candidate of two': (response) =>
            (candidatesOf(response)[1]! as Map<String, Object?>).remove('card'),
        'a result beside the candidates': (response) =>
            response['result'] = candidatesOf(response).first,
      };
      for (final MapEntry(key: breakage, value: breakResponse) in breakages.entries) {
        test('$breakage → server failure, reported', () {
          final response = chooserResponse();
          breakResponse(response);
          final answer = _parser.read(httpStatus: 200, body: response, requestIdHeader: null);
          expect(answer, isA<UnreadableAnswer>());
          expect(_describe(_decide(answer)), 'server failure, reported');
        });
      }

      test('three candidates, one unreadable: the chooser offers the two it can show', () {
        final response = chooserResponse();
        final third = jsonDecode(jsonEncode(candidatesOf(response).first)) as Map<String, Object?>;
        (third['station']! as Map<String, Object?>)['id'] = '0192a6c4-1111-4000-8000-000000000003';
        third.remove('title');
        candidatesOf(response).add(third);
        final answer = _parser.read(httpStatus: 200, body: response) as ChooseStationAnswer;
        expect(answer.candidates.map((candidate) => candidate.stationName), [
          'Station A',
          'Station B',
        ]);
      });

      test('the app never reorders: the answer\'s order is the sheet\'s', () {
        final response = chooserResponse();
        final candidates = candidatesOf(response);
        candidates.add(candidates.removeAt(0));
        final answer = _parser.read(httpStatus: 200, body: response) as ChooseStationAnswer;
        expect(answer.candidates.map((candidate) => candidate.stationName), [
          'Station B',
          'Station A',
        ]);
      });
    });

    group('images are kept only from https, with the sizes the screen relies on', () {
      Map<String, Object?> image({
        Object? address = 'https://images.lookup.invalid/header/abc.webp',
        Object? widthPixels = 720,
        Object? heightPixels = 360,
        Object? sizeBytes = 48000,
      }) => {
        'address': address,
        'width_pixels': widthPixels,
        'height_pixels': heightPixels,
        'size_bytes': sizeBytes,
      };

      PublicImage? headerImageRead(Object? headerImage) {
        final response =
            jsonDecode(
                  jsonEncode(
                    (validResponses
                            .firstWhere((fixture) => fixture.name == 'match-campaign')
                            .content
                        as Map<String, Object?>)['response'],
                  ),
                )
                as Map<String, Object?>;
        ((response['result']! as Map<String, Object?>)['card']!
                as Map<String, Object?>)['header_image'] =
            headerImage;
        return (_parser.read(httpStatus: 200, body: response) as MatchAnswer).result.headerImage;
      }

      test('a well-formed https image is kept', () {
        expect(headerImageRead(image()), isNotNull);
        expect(headerImageRead(image(widthPixels: 4096, heightPixels: 1)), isNotNull);
      });

      final droppedImages = <String, Object?>{
        'http': image(address: 'http://images.lookup.invalid/x.webp'),
        'HTTPS in capitals': image(address: 'HTTPS://images.lookup.invalid/x.webp'),
        'no host': image(address: 'https:///x.webp'),
        'a space': image(address: 'https://images.lookup.invalid/a b.webp'),
        'javascript': image(address: 'javascript:alert(1)'),
        'data': image(address: 'data:image/png;base64,AAAA'),
        'protocol-relative': image(address: '//images.lookup.invalid/x.webp'),
        'an address that is not text': image(address: 42),
        'an address over 2048 characters': image(
          address: 'https://images.lookup.invalid/${'a' * 2048}',
        ),
        'no size': image(sizeBytes: null),
        'a zero size': image(sizeBytes: 0),
        'a width of 0': image(widthPixels: 0),
        'a height over 4096': image(heightPixels: 4097),
        'a width with a fraction': image(widthPixels: 720.5),
        'a list': <Object?>[],
      };
      for (final MapEntry(key: problem, value: headerImage) in droppedImages.entries) {
        test('$problem → no image, and the card is still shown', () {
          expect(headerImageRead(headerImage), isNull);
        });
      }
    });

    group('error envelopes are read tolerantly', () {
      test('a code that breaks the contract pattern counts as unknown, so the status decides', () {
        for (final errorCode in ['invalid_audio', 'Invalid_Audio', 'X', 'INVALID AUDIO', 42]) {
          final answer =
              _parser.read(
                    httpStatus: 400,
                    body: {
                      'error': {'code': errorCode, 'request_id': _fixtureRequestId},
                    },
                  )
                  as ErrorStatusAnswer;
          expect(answer.errorCode, isNull, reason: '$errorCode');
          expect(_describe(_decide(answer)), 'server failure, reported', reason: '$errorCode');
        }
      });

      test('field problems that break the contract are left out, the rest kept', () {
        final answer =
            _parser.read(
                  httpStatus: 400,
                  body: {
                    'error': {
                      'code': 'VALIDATION_FAILED',
                      'request_id': _fixtureRequestId,
                      'fields': [
                        {'path': 'captured_at', 'code': 'invalid_format'},
                        {'path': 'a path with spaces', 'code': 'invalid_format'},
                        {'path': 'sent_at', 'code': 'Not A Code'},
                        {'path': 'codec'},
                        'codec',
                        {'path': 'card.actions[0].label', 'code': 'too_big'},
                      ],
                    },
                  },
                )
                as ErrorStatusAnswer;
        expect(answer.fieldProblems, const [
          FieldProblem(path: 'captured_at', code: 'invalid_format'),
          FieldProblem(path: 'card.actions[0].label', code: 'too_big'),
        ]);
      });

      test('an envelope with no fields, or fields that are not a list, has no field problems', () {
        for (final fields in [null, 'captured_at', 42, <String, Object?>{}]) {
          final answer =
              _parser.read(
                    httpStatus: 400,
                    body: {
                      'error': {'code': 'VALIDATION_FAILED', 'fields': fields},
                    },
                  )
                  as ErrorStatusAnswer;
          expect(answer.fieldProblems, isEmpty);
        }
      });

      test('the Retry-After seconds are passed on as read, for the policy to clamp', () {
        final answer =
            _parser.read(httpStatus: 503, body: null, retryAfterSeconds: 999) as ErrorStatusAnswer;
        expect(answer.retryAfterSeconds, 999);
        expect(_describe(_decide(answer)), 'busy 60 s, clip kept');
      });
    });
  });
}
