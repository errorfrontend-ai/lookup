import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/repository_file_locator.dart';
import 'contract_schema_checker.dart';

const String _idempotencyKey = '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a';

/// The contract's bounds on a clip's length (`recognize-schemas.ts`), which the emitted schema's
/// pattern alone does not carry.
const int _shortestClipMilliseconds = 2000;
const int _longestClipMilliseconds = 15000;

/// The text fields as one map, for checks by name.
Map<String, Object?> _fieldMap(RecognizeRequestParts parts) => Map.fromEntries(parts.textFields);

CapturedClip _clip({
  String idempotencyKey = _idempotencyKey,
  DateTime? capturedAt,
  List<int> audioBytes = const [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
}) => CapturedClip(
  audioBytes: audioBytes,
  idempotencyKey: idempotencyKey,
  capturedAt: capturedAt ?? DateTime.utc(2026, 10, 8, 9, 15, 2, 123),
  settings: ClipSettings.standard,
);

void main() {
  const builder = RecognizeRequestBuilder();
  final schema =
      jsonDecode(
            RepositoryFileLocator.file(
              'packages/contracts/schemas/recognize-request-fields.schema.json',
            ).readAsStringSync(),
          )
          as Map<String, Object?>;
  final validFixtures = ContractFixtures.readFolder('recognition/recognize-request/valid');
  final invalidFixtures = ContractFixtures.readFolder('recognition/recognize-request/invalid');
  Map<String, Object?> fieldsOf(NamedFixture fixture) =>
      (fixture.content as Map<String, Object?>)['fields'] as Map<String, Object?>;

  test('the loader finds the one valid and two invalid request fixtures', () {
    expect(validFixtures.map((fixture) => fixture.name), ['live-identify']);
    expect(invalidFixtures.map((fixture) => fixture.name), [
      'listener-install-id',
      'times-without-a-time-zone',
    ]);
  });

  group('the schema checker', () {
    test('passes the valid fixture and refuses each invalid one, so it can fail', () {
      expect(ContractSchemaChecker.problemsWith(fieldsOf(validFixtures.single), schema), isEmpty);
      for (final fixture in invalidFixtures) {
        expect(
          ContractSchemaChecker.problemsWith(fieldsOf(fixture), schema),
          isNotEmpty,
          reason: fixture.name,
        );
      }
    });

    test('refuses a missing field, a wrong codec and a non-text value', () {
      final fields = {...fieldsOf(validFixtures.single)};
      expect(
        ContractSchemaChecker.problemsWith({...fields}..remove('sent_at'), schema),
        contains('sent_at is required'),
      );
      expect(ContractSchemaChecker.problemsWith({...fields, 'codec': 'mp3'}, schema), hasLength(1));
      expect(
        ContractSchemaChecker.problemsWith({...fields, 'is_deferred': false}, schema),
        contains('is_deferred is not text'),
      );
    });
  });

  group('a live identify (S4-D8, §3.10)', () {
    final parts = builder.build(_clip(), sentAt: DateTime.utc(2026, 10, 8, 9, 15, 10, 456));

    test('gives exactly the fields of live-identify.json, in its order, with its values', () {
      final expectedFields = fieldsOf(validFixtures.single);
      expect(parts.textFields.map((field) => field.key), expectedFields.keys);
      expect(_fieldMap(parts), expectedFields);
    });

    test('passes recognize-request-fields.schema.json', () {
      expect(ContractSchemaChecker.problemsWith(_fieldMap(parts), schema), isEmpty);
    });

    test('states the clip length from the settings and the codec aac', () {
      expect(_fieldMap(parts)['clip_duration_milliseconds'], '8000');
      expect(
        int.parse(_fieldMap(parts)['clip_duration_milliseconds']! as String),
        allOf(
          ClipSettings.standard.clipDurationMilliseconds,
          inInclusiveRange(_shortestClipMilliseconds, _longestClipMilliseconds),
        ),
      );
      expect(_fieldMap(parts)['codec'], 'aac');
    });

    test('is not deferred and has no station hint', () {
      expect(_fieldMap(parts)['is_deferred'], 'false');
      expect(_fieldMap(parts).containsKey('station_hint'), isFalse);
    });

    test('sends the clip last, as the file clip.m4a of type audio/mp4 in the part audio', () {
      expect(parts.audioPart.fieldName, 'audio');
      expect(parts.audioPart.fileName, 'clip.m4a');
      expect(parts.audioPart.contentType, 'audio/mp4');
      expect(parts.audioPart.bytes, [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      expect(parts.textFields.map((field) => field.key), isNot(contains('audio')));
    });

    test('cannot be changed after it is built', () {
      expect(() => parts.textFields.add(const MapEntry('x', 'y')), throwsUnsupportedError);
    });
  });

  group('the mistakes of the invalid fixtures can never be made', () {
    test('listener-install-id: no field beyond the six of the contract, whatever the clip', () {
      final parts = builder.build(_clip(), sentAt: DateTime.utc(2026, 10, 8, 9, 15, 10));
      expect(parts.textFields.map((field) => field.key), [
        'clip_duration_milliseconds',
        'codec',
        'idempotency_key',
        'captured_at',
        'sent_at',
        'is_deferred',
      ]);
      expect(parts.textFields.map((field) => field.key), isNot(contains('listener_install_id')));
    });

    test('times-without-a-time-zone: local times are sent in UTC with milliseconds and Z', () {
      final localCapture = DateTime(2026, 10, 8, 11, 15, 2, 123);
      final localSend = DateTime(2026, 10, 8, 11, 15, 10, 456);
      final fields = _fieldMap(builder.build(_clip(capturedAt: localCapture), sentAt: localSend));
      final utcTimestamp = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$');
      expect(fields['captured_at'], matches(utcTimestamp));
      expect(fields['sent_at'], matches(utcTimestamp));
      expect(DateTime.parse(fields['captured_at']! as String), localCapture.toUtc());
      expect(DateTime.parse(fields['sent_at']! as String), localSend.toUtc());
      expect(ContractSchemaChecker.problemsWith(fields, schema), isEmpty);
    });

    test('microseconds are cut to milliseconds, never written as six decimals', () {
      expect(
        RecognizeRequestBuilder.formatUtcTimestamp(DateTime.utc(2026, 10, 8, 9, 15, 2, 123, 456)),
        '2026-10-08T09:15:02.123Z',
      );
      expect(
        RecognizeRequestBuilder.formatUtcTimestamp(DateTime.utc(2026, 1, 2, 3, 4, 5)),
        '2026-01-02T03:04:05.000Z',
      );
    });
  });

  group('every send of one clip', () {
    test('carries the same key and capture time, and its own send time', () {
      final clip = _clip();
      final firstSend = _fieldMap(
        builder.build(clip, sentAt: DateTime.utc(2026, 10, 8, 9, 15, 10, 456)),
      );
      final resendAfterBusy = _fieldMap(
        builder.build(clip, sentAt: DateTime.utc(2026, 10, 8, 9, 15, 22, 456)),
      );
      expect(resendAfterBusy['idempotency_key'], firstSend['idempotency_key']);
      expect(resendAfterBusy['captured_at'], firstSend['captured_at']);
      expect(firstSend['sent_at'], '2026-10-08T09:15:10.456Z');
      expect(resendAfterBusy['sent_at'], '2026-10-08T09:15:22.456Z');
      expect(
        DateTime.parse(
          resendAfterBusy['sent_at']! as String,
        ).isAfter(DateTime.parse(resendAfterBusy['captured_at']! as String)),
        isTrue,
      );
    });

    test('two captures carry two different keys', () {
      final sentAt = DateTime.utc(2026, 10, 8, 9, 15, 10);
      final first = _fieldMap(builder.build(_clip(), sentAt: sentAt));
      final second = _fieldMap(
        builder.build(
          _clip(idempotencyKey: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f'),
          sentAt: sentAt,
        ),
      );
      expect(first['idempotency_key'], isNot(second['idempotency_key']));
    });

    test('sends the key in lower case, as the contract example shows', () {
      final fields = _fieldMap(
        builder.build(
          _clip(idempotencyKey: '3B9E7C1A-5D2F-4E8B-9A6C-1F0D2E3C4B5A'),
          sentAt: DateTime.utc(2026, 10, 8, 9, 15, 10),
        ),
      );
      expect(fields['idempotency_key'], _idempotencyKey);
    });
  });
}
