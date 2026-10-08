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

import '../../../support/contract_fixtures.dart';

const RecognizeResponseParser _parser = RecognizeResponseParser();
const String _fixtureRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/// What each recognize-response fixture leads to (§4.4). Every fixture in the folders must be named
/// here, so a new fixture fails the test until someone decides what the app does with it.
const Map<String, String> _expectedValidStates = {
  'choose-station': 'newer app needed, several stations',
  'match-campaign': 'matched',
  'match-client-default': 'fallback',
  'match-with-images': 'matched',
  'no-match': 'no match',
  'no-match-deferred-with-offset': 'no match',
};

const Map<String, String> _expectedInvalidStates = {
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
  'rate-limited': 'too many tries, short wait',
  'recognition-busy': 'busy 10 s, clip kept',
  'recognition-in-progress': 'wait 3 s and resend, clip kept',
  'recognition-timeout': 'busy 5 s, clip kept',
  'service-unavailable': 'busy 10 s, clip kept',
  'unsupported-media-type': 'server failure, reported',
  'validation-failed': 'server failure, reported',
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
    ConnectionLostOutcome() => 'no connection, clip kept',
    FinishedOutcome(:final nextState) => switch (nextState) {
      MatchedState() => 'matched',
      FallbackState() => 'fallback',
      NoMatchState() => 'no match',
      ErrorState(failure: NewerAppNeededFailure(isSeveralStations: true)) =>
        'newer app needed, several stations',
      ErrorState(failure: NewerAppNeededFailure()) => 'newer app needed',
      ErrorState(failure: TooManyTriesFailure(isShortWait: true)) => 'too many tries, short wait',
      ErrorState(failure: TooManyTriesFailure()) => 'too many tries, later',
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
  result.stationId,
  result.stationName,
  result.stationFrequencyLabel,
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
    'the loader finds 6 valid and 13 invalid responses and 14 envelopes, each with an expectation',
    () {
      expect(validResponses, hasLength(6));
      expect(invalidResponses, hasLength(13));
      expect(envelopes, hasLength(14));
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
        } else {
          expect(_describe(outcome), expected);
        }
      });
    }

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

    test('busy envelopes four times in a row end in Error; 409 three times; 401 twice', () {
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
        expect(_describe(sendRepeatedly(busyFixture, 3)), startsWith('busy'), reason: busyFixture);
        expect(_describe(sendRepeatedly(busyFixture, 4)), 'server failure', reason: busyFixture);
      }
      expect(_describe(sendRepeatedly('recognition-in-progress', 2)), startsWith('wait'));
      expect(_describe(sendRepeatedly('recognition-in-progress', 3)), 'server failure');
      expect(_describe(sendRepeatedly('install-token-invalid', 2)), 'server failure, reported');
    });
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
