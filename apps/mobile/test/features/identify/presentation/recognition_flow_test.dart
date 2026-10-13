import 'dart:async';
import 'dart:convert';
import 'dart:io' show File, FileSystemException;

import 'package:dio/dio.dart' show DioExceptionType, ResponseBody;
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/history_answer_reader.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/outbox/outbox_store.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/settings/data/my_station_store.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';

import '../../../support/contract_fixtures.dart';
import '../../../support/example_app_configurations.dart';
import '../../../support/received_multipart_form.dart';
import '../../../support/recording_client_error_reporter.dart';
import 'recognition_flow_harness.dart';

final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

const String _acceptedReportId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/// The chooser fixture's recognition and stations (`recognize-response/valid/choose-station.json`).
const String _chooserRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';
const String _stationAId = '0192a6c4-1111-4000-8000-000000000001';
const String _stationBId = '0192a6c4-1111-4000-8000-000000000002';

/// The recognition id the shared answer fixtures carry, which History keys their results by.
const String _savedRecognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

/// "My station" as `MyStationStore` keeps it, for a test's starting preferences.
const String _stationAStored =
    '{"id":"$_stationAId","name":"Station A","frequency_label":"98.1 FM","city":"Lusaka"}';

/// An outbox whose disk refuses every change, as a full phone would.
class _BrokenOutboxStore implements OutboxStore {
  @override
  Future<bool> queueStationChoice({
    required String recognitionId,
    required String stationId,
  }) async => throw const FileSystemException('The phone is full');

  @override
  Future<QueuedDeferredClip> queueDeferredClip({
    required String idempotencyKey,
    required DateTime capturedAt,
    required int clipDurationMilliseconds,
    required String codec,
    required String? stationHintId,
    required List<int> audioBytes,
    required DeferredClipSavedReason savedReason,
  }) async => throw const FileSystemException('The phone is full');

  @override
  Object? noSuchMethod(Invocation invocation) => throw UnimplementedError('$invocation');
}

/// The `station_hint` each recognize request carried, in order; null when it carried none.
List<String?> _sentHints(RecognitionFlowHarness harness) => [
  for (final request in harness.recognizeRequests)
    ReceivedMultipartForm.of(request).fieldValues['station_hint'],
];

/// A crash reporter whose answers wait until the test releases them, so the listener can act while
/// a report is on its way (T39).
class _HeldClientErrorReporter extends RecordingClientErrorReporter {
  final Completer<void> release = Completer<void>();

  @override
  Future<ClientErrorReportOutcome> report({
    required ClientErrorKind kind,
    required Object error,
    StackTrace? stackTrace,
    String? description,
    String? location,
    String? relatedRequestId,
    String? reportRequestId,
  }) async {
    final outcome = await super.report(
      kind: kind,
      error: error,
      stackTrace: stackTrace,
      description: description,
      location: location,
      relatedRequestId: relatedRequestId,
      reportRequestId: reportRequestId,
    );
    await release.future;
    return outcome;
  }
}

/// The failure an Error state shows; fails the test when the state is not an error.
RecognitionFailure _failureOf(RecognitionState state) => switch (state) {
  ErrorState(:final failure) => failure,
  _ => throw TestFailure('Expected an error state, but the flow shows $state.'),
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Runs an identify to the point where the API's answer for the first send is shown.
  void identifyAndAnswer(RecognitionFlowHarness harness, void Function() scriptAnswer) {
    scriptAnswer();
    harness.identifyAndRecord();
  }

  group('starting an identify', () {
    test('T1 idle, "Tap to identify", microphone allowed: recording(level 0, 8 s left)', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        expect(harness.state, const RecordingState(levelFraction: 0, secondsLeft: 8));
        expect(harness.recorder.isRecording, isTrue);
        expect(harness.recorder.startedIdempotencyKeys.single, matches(_versionFourUuid));
        expect(harness.recorder.startedSettings.single, same(ClipSettings.standard));
        expect(harness.permission.readCount, 1);
        expect(harness.permission.promptCount, 0, reason: 'reading the status shows no prompt');
      });
    });

    test('T1 the capture time is the moment recording started', () {
      runFlowTest((harness) {
        harness.answerWithResponseFixture('valid/no-match');
        harness.wait(const Duration(seconds: 3));
        harness.identifyAndRecord();
        final form = ReceivedMultipartForm.of(harness.recognizeRequests.single);
        expect(form.fieldValues['captured_at'], '2026-10-08T12:00:03.000Z');
        expect(form.fieldValues['sent_at'], '2026-10-08T12:00:11.000Z');
      });
    });

    for (final access in [
      MicrophoneAccess.notAskedYet,
      MicrophoneAccess.refusedOnce,
      MicrophoneAccess.refusedForGood,
    ]) {
      test('T2 idle, "Tap to identify", not allowed (${access.name}): permissionNeeded', () {
        runFlowTest(microphoneAccess: access, (harness) {
          harness.tap((flow) => flow.identify());
          expect(harness.state, PermissionNeededState(microphoneAccess: access));
          expect(harness.permission.promptCount, 0, reason: 'no system prompt (S4-PERMISSION-01)');
          expect(harness.recorder.startedIdempotencyKeys, isEmpty);
        });
      });
    }
  });

  group('the Permission screen', () {
    test('T3 "Allow microphone", allowed in the prompt: recording', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        expect(harness.state, const RecordingState(levelFraction: 0, secondsLeft: 8));
        expect(harness.permission.promptCount, 1);
        expect(harness.recorder.startedIdempotencyKeys, hasLength(1));
      });
    });

    test('T3 once allowed, later identifies never show the prompt again', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.answerWithResponseFixture('valid/no-match');
        harness.answerWithResponseFixture('valid/no-match');
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        harness.wait(const Duration(seconds: 8));
        expect(harness.state, const NoMatchState());
        harness.tap((flow) => flow.backToHome());
        harness.identifyAndRecord();
        expect(harness.state, const NoMatchState());
        expect(harness.permission.promptCount, 1);
        expect(harness.recorder.startedIdempotencyKeys, hasLength(2));
      });
    });

    test('T4 "Allow microphone", refused in the prompt: permissionNeeded(refused once)', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.permission.answerToPrompt = MicrophoneAccess.refusedOnce;
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        expect(
          harness.state,
          const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedOnce),
        );
        expect(harness.recorder.startedIdempotencyKeys, isEmpty);
      });
    });

    test('T5 "Allow microphone", refused for good: permissionNeeded(refused for good)', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.refusedOnce, (harness) {
        harness.permission.answerToPrompt = MicrophoneAccess.refusedForGood;
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        expect(
          harness.state,
          const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedForGood),
        );
        expect(harness.recorder.startedIdempotencyKeys, isEmpty);
      });
    });

    test('T5 refused for good, the primary button opens the settings and asks nothing', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.refusedForGood, (harness) {
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        expect(harness.permission.promptCount, 0);
        expect(harness.permission.settingsOpenCount, 1);
        expect(
          harness.state,
          const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedForGood),
        );
      });
    });

    test('T5 a double tap on "Allow microphone" shows one prompt', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.permission.promptGate = Completer<void>();
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        harness.tap((flow) => flow.allowMicrophone());
        harness.permission.promptGate!.complete();
        harness.settle();
        expect(harness.permission.promptCount, 1);
        expect(harness.recorder.startedIdempotencyKeys, hasLength(1));
      });
    });

    for (final access in [
      MicrophoneAccess.notAskedYet,
      MicrophoneAccess.refusedOnce,
      MicrophoneAccess.refusedForGood,
    ]) {
      test('T6 "Open phone settings" (${access.name}): unchanged, settings opened', () {
        runFlowTest(microphoneAccess: access, (harness) {
          harness.tap((flow) => flow.identify());
          harness.tap((flow) => flow.openPhoneSettings());
          expect(harness.permission.settingsOpenCount, 1);
          expect(harness.state, PermissionNeededState(microphoneAccess: access));
          expect(harness.permission.promptCount, 0);
        });
      });
    }

    test('T7 back in the foreground, now allowed: idle, and nothing recorded', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.refusedForGood, (harness) {
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.openPhoneSettings());
        harness.moveAppTo(AppLifecycleState.paused);
        harness.permission.access = MicrophoneAccess.granted;
        harness.moveAppTo(AppLifecycleState.resumed);
        expect(harness.state, const IdleState());
        expect(harness.recorder.startedIdempotencyKeys, isEmpty);
        expect(harness.permission.promptCount, 0);
      });
    });

    test('T7 back in the foreground, still refused: the screen stays', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.refusedForGood, (harness) {
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.openPhoneSettings());
        harness.moveAppTo(AppLifecycleState.paused);
        harness.moveAppTo(AppLifecycleState.resumed);
        expect(
          harness.state,
          const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedForGood),
        );
      });
    });

    test('T7 coming back from the system prompt is not mistaken for coming back from settings', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.permission.promptGate = Completer<void>();
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.allowMicrophone());
        harness.moveAppTo(AppLifecycleState.inactive);
        harness.permission.access = MicrophoneAccess.granted;
        harness.moveAppTo(AppLifecycleState.resumed);
        harness.permission.promptGate!.complete();
        harness.settle();
        expect(harness.state, const RecordingState(levelFraction: 0, secondsLeft: 8));
      });
    });

    test('T8 Back, "Not now" or system back: idle, no request', () {
      runFlowTest(microphoneAccess: MicrophoneAccess.notAskedYet, (harness) {
        harness.tap((flow) => flow.identify());
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.permission.promptCount, 0);
        expect(harness.adapter.requests, isEmpty);
      });
    });
  });

  group('Listening', () {
    test('T9 a level sample every 100 ms: new level, same seconds', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        harness.wait(const Duration(milliseconds: 100));
        expect(harness.state, const RecordingState(levelFraction: 0.25, secondsLeft: 8));
        harness.wait(const Duration(milliseconds: 100));
        expect(harness.state, const RecordingState(levelFraction: 0.5, secondsLeft: 8));
      });
    });

    test('T10 one second passes: one second less, the level kept, levels within 0 to 1', () {
      runFlowTest((harness) {
        harness.answerWithResponseFixture('valid/no-match');
        harness.identifyAndRecord();
        final recordingStates = harness.states.whereType<RecordingState>().toList();
        final seconds = <int>[];
        for (final state in recordingStates) {
          if (seconds.isEmpty || seconds.last != state.secondsLeft) seconds.add(state.secondsLeft);
          expect(state.levelFraction, inInclusiveRange(0, 1));
        }
        expect(seconds, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
      });
    });

    test(
      'T11 8 seconds reached: recording(0 s), then uploading; the clip is read and its file gone',
      () {
        runFlowTest((harness) {
          harness.adapter.waitUntilCancelled();
          harness.tap((flow) => flow.identify());
          harness.wait(const Duration(milliseconds: 7999));
          expect(harness.state, isA<RecordingState>());
          expect(harness.recognizeRequests, isEmpty);
          harness.wait(const Duration(milliseconds: 1));
          final lastStates = harness.states.sublist(harness.states.length - 2);
          expect(lastStates.first, isA<RecordingState>());
          expect((lastStates.first as RecordingState).secondsLeft, 0);
          expect(lastStates.last, const UploadingState());
          expect(harness.recorder.finishCount, 1);
          expect(harness.recorder.clipFileNames, isEmpty);
          final audio = ReceivedMultipartForm.of(harness.recognizeRequests.single).fileParts.single;
          expect(audio.bytes, harness.recorder.clipBytes);
          expect(harness.flow.hasKeptClip, isTrue);
        });
      },
    );

    test('T12 Close ×, "Cancel" or system back: idle, the recorder cancelled, nothing sent', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        harness.wait(const Duration(seconds: 3));
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.recorder.cancelCount, 1);
        expect(harness.recorder.clipFileNames, isEmpty);
        harness.wait(const Duration(seconds: 30));
        expect(harness.adapter.requests, isEmpty);
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    for (final lifecycleState in [AppLifecycleState.hidden, AppLifecycleState.paused]) {
      test('T13 app ${lifecycleState.name} while recording: idle, cancelled, nothing sent', () {
        runFlowTest((harness) {
          harness.tap((flow) => flow.identify());
          harness.wait(const Duration(seconds: 2));
          harness.moveAppTo(lifecycleState);
          expect(harness.state, const IdleState());
          expect(harness.recorder.cancelCount, 1);
          expect(harness.recorder.clipFileNames, isEmpty);
          harness.wait(const Duration(seconds: 30));
          harness.moveAppTo(AppLifecycleState.resumed);
          expect(harness.state, const IdleState());
          expect(harness.adapter.requests, isEmpty);
        });
      });
    }

    test('T13 the recorder paused by a call: idle, cancelled, nothing sent', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        harness.wait(const Duration(seconds: 4));
        harness.recorder.interrupt();
        harness.settle();
        expect(harness.state, const IdleState());
        expect(harness.recorder.cancelCount, 1);
        harness.wait(const Duration(seconds: 30));
        expect(harness.adapter.requests, isEmpty);
      });
    });

    test('T13 inactive alone (the notification shade) changes nothing', () {
      runFlowTest((harness) {
        harness.answerWithResponseFixture('valid/no-match');
        harness.tap((flow) => flow.identify());
        harness.wait(const Duration(seconds: 2));
        harness.moveAppTo(AppLifecycleState.inactive);
        harness.wait(const Duration(seconds: 6));
        expect(harness.state, const NoMatchState());
        expect(harness.recorder.cancelCount, 0);
      });
    });

    test('T13 hidden while the microphone is still opening: the recording is released at once', () {
      runFlowTest((harness) {
        harness.recorder.startGate = Completer<void>();
        harness.tap((flow) => flow.identify());
        harness.moveAppTo(AppLifecycleState.hidden);
        harness.recorder.startGate!.complete();
        harness.settle();
        expect(harness.state, const IdleState());
        expect(harness.recorder.cancelCount, 1);
        expect(harness.recorder.clipFileNames, isEmpty);
      });
    });

    test('T14 the recorder cannot start: error(phone failure), reported', () {
      runFlowTest((harness) {
        harness.recorder.startError = StateError('microphone busy');
        harness.tap((flow) => flow.identify());
        final failure = _failureOf(harness.state) as PhoneFailure;
        final report = harness.reporter.reports.single;
        expect(report.kind, ClientErrorKind.reported);
        expect(report.error, harness.recorder.startError);
        expect(report.location, '/listening');
        expect(report.reportRequestId, failure.reportRequestId);
        expect(harness.adapter.requests, isEmpty);
      });
    });

    test('T14 the recorder cannot finish (clip missing or empty): error(phone failure)', () {
      runFlowTest((harness) {
        harness.recorder.finishError = StateError('The recorded clip is empty.');
        harness.identifyAndRecord();
        expect(_failureOf(harness.state), isA<PhoneFailure>());
        expect(harness.reporter.reports.single.error, harness.recorder.finishError);
        expect(harness.recorder.clipFileNames, isEmpty);
        expect(harness.adapter.requests, isEmpty);
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    for (final (cause, error) in <(String, Object)>[
      ('an error the platform reports', StateError('the encoder failed')),
      (
        'a stop nobody asked for',
        const ClipRecorderFailure('The recorder stopped on its own before the clip ended.'),
      ),
    ]) {
      test('T14 the recorder breaks while recording ($cause): error(phone failure) at once', () {
        runFlowTest((harness) {
          harness.tap((flow) => flow.identify());
          harness.wait(const Duration(seconds: 3));
          harness.recorder.failWhileRecording(error);
          harness.settle();
          final failure = _failureOf(harness.state) as PhoneFailure;
          final report = harness.reporter.reports.single;
          expect(report.kind, ClientErrorKind.reported);
          expect(report.error, same(error));
          expect(report.location, '/listening');
          expect(report.reportRequestId, failure.reportRequestId);
          expect(harness.recorder.finishCount, 0, reason: 'the broken clip is never read');
          expect(harness.recorder.cancelCount, 1, reason: 'the recorder is released');
          expect(harness.recorder.clipFileNames, isEmpty, reason: 'its file is deleted');
          expect(harness.flow.hasKeptClip, isFalse);
          harness.wait(const Duration(seconds: 30));
          expect(harness.adapter.requests, isEmpty, reason: 'nothing is sent');
          expect(harness.state, isA<ErrorState>());
          expect(harness.reporter.reports, hasLength(1), reason: 'reported once');
        });
      });
    }

    test('T14 a permission plugin failure is a reported phone failure too', () {
      runFlowTest((harness) {
        harness.permission.readError = StateError('plugin missing');
        harness.tap((flow) => flow.identify());
        expect(_failureOf(harness.state), isA<PhoneFailure>());
        expect(harness.reporter.reports.single.error, harness.permission.readError);
        expect(harness.reporter.reports.single.location, '/', reason: 'it failed on Home');
      });
    });
  });

  group('Identifying and the answers (§3.11)', () {
    test('T15 no usable install token: registers first, then sends, still uploading', () {
      runFlowTest(hasStoredToken: false, (harness) {
        harness.adapter.answerJson(200, {
          'install_token': 'new.install.token',
          'expires_at': '2026-11-07T12:00:00Z',
        });
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.identifyAndRecord();
        expect(harness.adapter.requests.map((request) => request.address.path), [
          '/api/v1/installs',
          '/api/v1/recognize',
        ]);
        expect(
          harness.recognizeRequests.single.header('Authorization'),
          'Bearer new.install.token',
        );
        expect(harness.states.whereType<UploadingState>(), hasLength(1));
        expect(harness.state, isA<MatchedState>());
      });
    });

    test('T16 200 MATCH, kind CAMPAIGN: matched, the clip deleted', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/match-campaign'));
        expect(harness.state, isA<MatchedState>());
        expect((harness.state as MatchedState).result.clientName, 'Brand A');
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test('T16 200 MATCH with a kind the app does not know: matched', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('invalid/unknown-result-kind'),
        );
        expect(harness.state, isA<MatchedState>());
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test('T17 200 MATCH, kind CLIENT_DEFAULT: fallback, the clip deleted', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('valid/match-client-default'),
        );
        expect(harness.state, isA<FallbackState>());
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test('T18 200 NO_MATCH: noMatch, the clip deleted', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(harness.state, const NoMatchState());
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test('T19′ 200 CHOOSE_STATION: the chooser, both stations with their cards (P6-STATE-03)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        final chooser = harness.state as ChooseStationState;
        expect(chooser.recognitionId, _chooserRecognitionId);
        expect(chooser.origin, ChooserOrigin.liveIdentify);
        expect(chooser.candidates.map((candidate) => candidate.stationName), [
          'Station A',
          'Station B',
        ]);
        expect(chooser.candidates.map((candidate) => candidate.card.shownActions.first.label), [
          'Call us',
          'Call us',
        ]);
        expect(harness.flow.hasKeptClip, isFalse);
        expect(harness.reporter.reports, isEmpty);
        expect(harness.outboxItems, isEmpty, reason: 'nothing is queued before a row is tapped');
      });
    });

    for (final fixture in [
      'choose-station-one-candidate',
      'choose-station-five-candidates',
      'choose-station-same-station-twice',
      'choose-station-with-result',
    ]) {
      test('T19″ $fixture: error(server failure), reported, the clip deleted', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => harness.answerWithResponseFixture('invalid/$fixture'));
          expect(_failureOf(harness.state), isA<ServerFailure>());
          expect(harness.reporter.reports, hasLength(1));
          expect(harness.flow.hasKeptClip, isFalse);
        });
      });
    }

    test('T19 an unknown status: error(newer app needed); a 426: please update the app', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('invalid/ambiguous-status'),
        );
        expect(_failureOf(harness.state), const NewerAppNeededFailure());
        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(
          harness,
          () => harness.adapter.answerJson(426, {
            'error': {'code': 'APP_UPDATE_REQUIRED', 'message': 'Update the app.'},
          }),
        );
        expect(_failureOf(harness.state), const AppUpdateRequiredFailure(), reason: 'T26′');
        expect(harness.flow.hasKeptClip, isFalse);
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('T20 503 RECOGNITION_BUSY, Retry-After 12: busy(12, 12), the clip kept', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '12'),
        );
        expect(harness.state, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 12));
        expect(harness.flow.hasKeptClip, isTrue);
      });
    });

    test('T20 502, 503 with any code, and 504, with no Retry-After: busy for 10 s', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('service-unavailable'));
        expect(harness.state, const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 10));
        harness.adapter.answerText(502, '<html>Bad gateway</html>');
        harness.tap((flow) => flow.tryNow());
        expect(harness.state, const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 10));
        harness.adapter.answerText(504, '');
        harness.tap((flow) => flow.tryNow());
        expect(harness.state, const BusyState(retryDelaySeconds: 10, secondsUntilRetry: 10));
        expect(harness.flow.hasKeptClip, isTrue);
      });
    });

    test('T21′ the 4th send still busy: Saved offline (busy), the clip handed to the outbox', () {
      runFlowTest((harness) {
        for (var send = 0; send < 4; send++) {
          harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '5');
        }
        harness.identifyAndRecord();
        for (var resend = 0; resend < 3; resend++) {
          expect(harness.state, isA<BusyState>());
          harness.wait(const Duration(seconds: 5));
        }
        expect(
          harness.state,
          const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
        );
        expect(harness.recognizeRequests, hasLength(4));
        expect(harness.sentIdempotencyKeys.toSet(), hasLength(1));
        expect(harness.sentRequestIds.toSet(), hasLength(4), reason: 'a new request id per send');
        expect(harness.flow.hasKeptClip, isFalse, reason: 'it is in the outbox now, not in memory');
        _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.busy);
        expect(harness.reporter.reports, isEmpty);
        harness.wait(const Duration(minutes: 1));
        expect(harness.recognizeRequests, hasLength(4), reason: 'the live flow sends no more');
      });
    });

    test('T21′ the 4th busy answer with no API id is kept for later too, with no report', () {
      runFlowTest((harness) {
        for (var send = 0; send < 4; send++) {
          harness.adapter.answerText(502, '<html>Bad gateway</html>');
        }
        harness.identifyAndRecord();
        for (var resend = 0; resend < 3; resend++) {
          harness.tap((flow) => flow.tryNow());
        }
        expect(harness.state, isA<SavedOfflineState>());
        expect(harness.reporter.reports, isEmpty);
        _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.busy);
      });
    });

    test('T22 409 RECOGNITION_IN_PROGRESS: waits Retry-After, sends the same clip and key', () {
      runFlowTest((harness) {
        harness.answerWithEnvelopeFixture('recognition-in-progress');
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.identifyAndRecord();
        expect(harness.state, const UploadingState());
        expect(harness.flow.hasKeptClip, isTrue);
        harness.wait(const Duration(milliseconds: 2999));
        expect(harness.recognizeRequests, hasLength(1));
        harness.wait(const Duration(milliseconds: 1));
        expect(harness.state, isA<MatchedState>());
        expect(harness.sentIdempotencyKeys.toSet(), hasLength(1));
        expect(harness.sentRequestIds.toSet(), hasLength(2));
        expect(harness.states.whereType<ErrorState>(), isEmpty);
      });
    });

    test('T22 at most two waits: the third 409 is error(server failure)', () {
      runFlowTest((harness) {
        for (var send = 0; send < 3; send++) {
          harness.answerWithEnvelopeFixture('recognition-in-progress');
        }
        harness.identifyAndRecord();
        harness.wait(const Duration(seconds: 6));
        expect(
          _failureOf(harness.state),
          ServerFailure(
            requestId: RecognitionFlowHarness.envelopeRequestId('recognition-in-progress'),
          ),
        );
        expect(harness.recognizeRequests, hasLength(3));
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test('T22 the 409 wait pauses while the app is hidden, and goes on when it is shown', () {
      runFlowTest((harness) {
        harness.answerWithEnvelopeFixture('recognition-in-progress', retryAfter: '3');
        harness.identifyAndRecord();
        harness.wait(const Duration(seconds: 1));
        harness.moveAppTo(AppLifecycleState.hidden);
        harness.wait(const Duration(minutes: 5));
        expect(harness.state, const UploadingState());
        expect(harness.recognizeRequests, hasLength(1), reason: 'no send from a hidden app');
        expect(harness.flow.hasKeptClip, isTrue);
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.moveAppTo(AppLifecycleState.resumed);
        harness.wait(const Duration(milliseconds: 1999));
        expect(harness.recognizeRequests, hasLength(1), reason: 'the 2 seconds left are waited');
        harness.wait(const Duration(milliseconds: 1));
        expect(harness.state, isA<MatchedState>());
        expect(harness.sentIdempotencyKeys.toSet(), hasLength(1));
      });
    });

    test('T22 a 409 that arrives while the app is hidden waits for the app to return', () {
      runFlowTest((harness) {
        final release = Completer<void>();
        harness.adapter.answerWith((request, cancelFuture) async {
          await release.future;
          return ResponseBody.fromString(
            jsonEncode(
              (ContractFixtures.readFile('errors/envelopes/recognition-in-progress.json')!
                  as Map)['body'],
            ),
            409,
            headers: {
              'retry-after': ['3'],
            },
          );
        });
        harness.identifyAndRecord();
        harness.moveAppTo(AppLifecycleState.hidden);
        release.complete();
        harness.settle();
        harness.wait(const Duration(minutes: 1));
        expect(harness.state, const UploadingState());
        expect(harness.recognizeRequests, hasLength(1), reason: 'no send from a hidden app');
        harness.answerWithResponseFixture('valid/no-match');
        harness.moveAppTo(AppLifecycleState.resumed);
        harness.wait(const Duration(seconds: 3));
        expect(harness.state, const NoMatchState());
        expect(harness.recognizeRequests, hasLength(2));
      });
    });

    test('T23 401 INSTALL_TOKEN_INVALID: registers again (same install id), sends again', () {
      runFlowTest((harness) {
        harness.answerWithEnvelopeFixture('install-token-invalid');
        harness.adapter.answerJson(200, {
          'install_token': 'new.install.token',
          'expires_at': '2026-11-07T12:00:00Z',
        });
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.identifyAndRecord();
        expect(harness.adapter.requests.map((request) => request.address.path), [
          '/api/v1/recognize',
          '/api/v1/installs',
          '/api/v1/recognize',
        ]);
        expect((harness.adapter.requests[1].jsonBody! as Map)['install_id'], flowTestInstallId);
        expect(harness.recognizeRequests.last.header('Authorization'), 'Bearer new.install.token');
        expect(harness.sentIdempotencyKeys.toSet(), hasLength(1));
        expect(harness.state, isA<MatchedState>());
        expect(harness.states.whereType<ErrorState>(), isEmpty);
      });
    });

    test('T23 a second 401 for the clip: error(server failure), reported', () {
      runFlowTest((harness) {
        harness.answerWithEnvelopeFixture('install-token-invalid');
        harness.adapter.answerJson(200, {
          'install_token': 'new.install.token',
          'expires_at': '2026-11-07T12:00:00Z',
        });
        harness.answerWithEnvelopeFixture('install-token-invalid');
        harness.identifyAndRecord();
        final requestId = RecognitionFlowHarness.envelopeRequestId('install-token-invalid');
        expect(_failureOf(harness.state), ServerFailure(requestId: requestId));
        expect(harness.reporter.reports.single.relatedRequestId, requestId);
        expect(harness.adapter.requests, hasLength(3));
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    test(
      'T24′ 429 RATE_LIMITED: Saved offline (too many tries), the clip handed to the outbox',
      () {
        runFlowTest((harness) {
          identifyAndAnswer(
            harness,
            () => harness.answerWithEnvelopeFixture('rate-limited', retryAfter: '120'),
          );
          expect(
            harness.state,
            const SavedOfflineState(
              reason: SavedClipReason.tooManyTries,
              wasOldestClipDeleted: false,
            ),
          );
          expect(harness.flow.hasKeptClip, isFalse);
          _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.tooManyTries);
          expect(harness.reporter.reports, isEmpty);
        });
      },
    );

    test('T26′ 426 APP_UPDATE_REQUIRED: "Please update the app", the clip dropped, not kept', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('app-update-required'));
        expect(_failureOf(harness.state), const AppUpdateRequiredFailure());
        expect(harness.flow.hasKeptClip, isFalse);
        expect(harness.outboxItems, isEmpty);
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('T25 400 INVALID_AUDIO: error(recording unusable), the clip deleted, reported', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('invalid-audio'));
        final requestId = RecognitionFlowHarness.envelopeRequestId('invalid-audio');
        expect(_failureOf(harness.state), RecordingUnusableFailure(requestId: requestId));
        expect(harness.reporter.reports.single.relatedRequestId, requestId);
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    for (final (name, isReported) in [
      ('validation-failed', true),
      ('payload-too-large', true),
      ('forbidden', true),
      ('capture-expired', true),
      ('internal', false),
    ]) {
      test('T26 $name: error(server failure), ${isReported ? '' : 'not '}reported', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture(name));
          final requestId = RecognitionFlowHarness.envelopeRequestId(name);
          expect(_failureOf(harness.state), ServerFailure(requestId: requestId));
          expect(harness.reporter.reports, hasLength(isReported ? 1 : 0));
          expect(harness.flow.hasKeptClip, isFalse);
        });
      });
    }

    test('T26 a 200 the app cannot read: error(server failure), reported', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('invalid/match-without-result'),
        );
        expect(_failureOf(harness.state), isA<ServerFailure>());
        expect(harness.reporter.reports, hasLength(1));
        expect(harness.flow.hasKeptClip, isFalse);
      });
    });

    for (final type in [
      DioExceptionType.connectionError,
      DioExceptionType.connectionTimeout,
      DioExceptionType.receiveTimeout,
    ]) {
      test('T27′ no answer (${type.name}): Saved offline, and the outbox holds the clip with its '
          'original key, recording and capture time (P6-STATE-04, P6-OFFLINE-01)', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => harness.adapter.failWithDioType(type));
          expect(
            harness.state,
            const SavedOfflineState(
              reason: SavedClipReason.noConnection,
              wasOldestClipDeleted: false,
            ),
          );
          expect(harness.flow.hasKeptClip, isFalse);
          _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.noConnection);
          expect(harness.reporter.reports, isEmpty);
        });
      });
    }

    test('a request the phone itself stopped is a reported phone failure, not no connection', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.adapter.failWith(StateError('secret detail')));
        final failure = _failureOf(harness.state) as PhoneFailure;
        final report = harness.reporter.reports.single;
        expect(report.kind, ClientErrorKind.reported);
        expect(
          report.error,
          'Recognize request stopped on the phone: a fault in the app (StateError).',
          reason: 'the fault by its type only, never its text',
        );
        expect(report.relatedRequestId, isNull);
        expect(report.location, '/identifying');
        expect(report.reportRequestId, failure.reportRequestId);
        expect(harness.flow.hasKeptClip, isFalse, reason: 'sending again would fail the same way');
      });
    });

    test('plain http outside development is a reported phone failure, and nothing is sent', () {
      runFlowTest(
        configuration: MisbuiltAppConfiguration(
          flavour: AppFlavour.production,
          apiBaseUrl: 'http://api.lookup.invalid/api/v1',
        ),
        (harness) {
          harness.identifyAndRecord();
          expect(_failureOf(harness.state), isA<PhoneFailure>());
          expect(
            harness.reporter.reports.single.error,
            'Recognize request stopped on the phone: '
            'the address is plain http outside the development flavour.',
          );
          expect(harness.adapter.requests, isEmpty);
          expect(harness.flow.hasKeptClip, isFalse);
        },
      );
    });

    test('a refused install registration is reported as the registration, not the clip', () {
      runFlowTest(hasStoredToken: false, (harness) {
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('validation-failed'));
        final requestId = RecognitionFlowHarness.envelopeRequestId('validation-failed');
        expect(_failureOf(harness.state), ServerFailure(requestId: requestId));
        final report = harness.reporter.reports.single;
        expect(
          report.error,
          'Install registration answer HTTP 400 VALIDATION_FAILED (fields: captured_at '
          'invalid_format, sent_at invalid_format): the API refused what the app sent.',
        );
        expect(report.relatedRequestId, requestId);
        expect(harness.adapter.requests.map((request) => request.address.path), [
          '/api/v1/installs',
        ]);
      });
    });

    test('T28 "Cancel" while uploading: idle, the request cancelled, the clip deleted', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, harness.adapter.waitUntilCancelled);
        expect(harness.state, const UploadingState());
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.flow.hasKeptClip, isFalse);
        harness.wait(const Duration(minutes: 1));
        expect(harness.state, const IdleState());
        expect(harness.recognizeRequests, hasLength(1));
      });
    });

    test('T28 "Cancel" during a 409 wait: idle, nothing sent after it', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithEnvelopeFixture('recognition-in-progress'),
        );
        harness.tap((flow) => flow.backToHome());
        harness.wait(const Duration(seconds: 10));
        expect(harness.state, const IdleState());
        expect(harness.recognizeRequests, hasLength(1));
      });
    });
  });

  group('Busy', () {
    void reachBusy(RecognitionFlowHarness harness, {String retryAfter = '12'}) => identifyAndAnswer(
      harness,
      () => harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: retryAfter),
    );

    test('T29 one second passes in the foreground: busy(delay, seconds - 1)', () {
      runFlowTest((harness) {
        reachBusy(harness);
        harness.wait(const Duration(seconds: 1));
        expect(harness.state, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 11));
        harness.wait(const Duration(seconds: 10));
        expect(harness.state, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 1));
        expect(harness.recognizeRequests, hasLength(1));
      });
    });

    test('T30 the countdown reaches 0: the same clip and key, a new request id and send time', () {
      runFlowTest((harness) {
        reachBusy(harness);
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.wait(const Duration(seconds: 12));
        expect(harness.state, isA<MatchedState>());
        final forms = harness.recognizeRequests.map(ReceivedMultipartForm.of).toList();
        expect(forms, hasLength(2));
        expect(forms.map((form) => form.fieldValues['idempotency_key']).toSet(), hasLength(1));
        expect(forms.map((form) => form.fieldValues['captured_at']).toSet(), hasLength(1));
        expect(forms.map((form) => form.fieldValues['sent_at']), [
          '2026-10-08T12:00:08.000Z',
          '2026-10-08T12:00:20.000Z',
        ]);
        expect(forms.last.fileParts.single.bytes, forms.first.fileParts.single.bytes);
        expect(harness.sentRequestIds.toSet(), hasLength(2));
      });
    });

    test(
      'T31′ app hidden during Busy: Saved offline (busy), the clip handed to the outbox (P6-LISTENING-02)',
      () {
        runFlowTest((harness) {
          reachBusy(harness);
          harness.wait(const Duration(seconds: 2));
          harness.moveAppTo(AppLifecycleState.hidden);
          harness.wait(const Duration(minutes: 5));
          expect(
            harness.state,
            const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
          );
          expect(
            harness.recognizeRequests,
            hasLength(1),
            reason: 'no live send from the background',
          );
          _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.busy);
          harness.moveAppTo(AppLifecycleState.resumed);
          harness.wait(const Duration(minutes: 1));
          expect(harness.state, isA<SavedOfflineState>());
          expect(harness.recognizeRequests, hasLength(1));
        });
      },
    );

    test('T31 inactive alone keeps the countdown going', () {
      runFlowTest((harness) {
        reachBusy(harness);
        harness.moveAppTo(AppLifecycleState.inactive);
        harness.wait(const Duration(seconds: 3));
        expect(harness.state, const BusyState(retryDelaySeconds: 12, secondsUntilRetry: 9));
      });
    });

    test('T31 a busy answer that arrives in the background waits for the app to return', () {
      runFlowTest((harness) {
        final release = Completer<void>();
        harness.adapter.answerWith((request, cancelFuture) async {
          await release.future;
          return ResponseBody.fromString(
            jsonEncode(
              (ContractFixtures.readFile('errors/envelopes/recognition-busy.json')! as Map)['body'],
            ),
            503,
            headers: {
              'retry-after': ['5'],
            },
          );
        });
        harness.identifyAndRecord();
        expect(harness.state, const UploadingState());
        harness.moveAppTo(AppLifecycleState.hidden);
        release.complete();
        harness.settle();
        // T31′: Busy with the app away hands the clip to the outbox, rather than waiting for the app.
        expect(
          harness.state,
          const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: false),
        );
        harness.wait(const Duration(minutes: 1));
        expect(harness.recognizeRequests, hasLength(1), reason: 'no live send from the background');
        _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.busy);
      });
    });

    test('T32 "Try now": uploading at once, the countdown stopped', () {
      runFlowTest((harness) {
        reachBusy(harness);
        harness.answerWithResponseFixture('valid/no-match');
        harness.wait(const Duration(seconds: 3));
        harness.tap((flow) => flow.tryNow());
        expect(harness.state, const NoMatchState());
        expect(harness.recognizeRequests, hasLength(2));
        expect(harness.sentIdempotencyKeys.toSet(), hasLength(1));
        harness.wait(const Duration(minutes: 1));
        expect(harness.recognizeRequests, hasLength(2));
      });
    });

    test('T33 Close ×, "Cancel" or system back: idle, the countdown stopped, the clip deleted', () {
      runFlowTest((harness) {
        reachBusy(harness);
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.flow.hasKeptClip, isFalse);
        harness.wait(const Duration(minutes: 1));
        expect(harness.recognizeRequests, hasLength(1));
      });
    });
  });

  group('Result, No match and Error', () {
    test('T34 an action button: the flow keeps the result (the Result screen opens it)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/match-campaign'));
        final shown = harness.state;
        harness.wait(const Duration(minutes: 5));
        expect(harness.state, same(shown));
        expect(harness.adapter.requests, hasLength(1));
      });
    });

    for (final fixture in ['valid/match-campaign', 'valid/match-client-default']) {
      test('T35 Back or system back from ${fixture.split('/').last}: idle', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => harness.answerWithResponseFixture(fixture));
          harness.tap((flow) => flow.backToHome());
          expect(harness.state, const IdleState());
        });
      });
    }

    test('T36 "Try again" on No match: a new capture with a new key', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        harness.tap((flow) => flow.tryAgain());
        expect(harness.state, const RecordingState(levelFraction: 0, secondsLeft: 8));
        final keys = harness.recorder.startedIdempotencyKeys;
        expect(keys, hasLength(2));
        expect(keys.first, isNot(keys.last));
        expect(harness.permission.readCount, 2, reason: 'the permission is checked first');
      });
    });

    for (final (name, scriptAnswer) in <(String, void Function(RecognitionFlowHarness))>[
      ('server failure', (harness) => harness.answerWithEnvelopeFixture('validation-failed')),
      ('recording unusable', (harness) => harness.answerWithEnvelopeFixture('invalid-audio')),
      ('phone failure', (harness) => harness.recorder.finishError = StateError('no clip')),
    ]) {
      test('T36 "Try again" on error($name): a new capture', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => scriptAnswer(harness));
          expect(harness.state, isA<ErrorState>());
          harness.recorder.finishError = null;
          harness.tap((flow) => flow.tryAgain());
          expect(harness.state, const RecordingState(levelFraction: 0, secondsLeft: 8));
          expect(harness.recorder.startedIdempotencyKeys.toSet(), hasLength(2));
        });
      });
    }

    test('T36 "Try again" with the microphone since refused: permissionNeeded', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        harness.permission.access = MicrophoneAccess.refusedOnce;
        harness.tap((flow) => flow.tryAgain());
        expect(
          harness.state,
          const PermissionNeededState(microphoneAccess: MicrophoneAccess.refusedOnce),
        );
        expect(harness.permission.promptCount, 0);
      });
    });

    test('T36 "Try again" is not offered on no connection, too many tries or newer app', () {
      for (final scriptAnswer in <void Function(RecognitionFlowHarness)>[
        (harness) => harness.adapter.failWithDioType(DioExceptionType.connectionError),
        (harness) => harness.answerWithEnvelopeFixture('rate-limited'),
        (harness) => harness.answerWithResponseFixture('invalid/ambiguous-status'),
      ]) {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => scriptAnswer(harness));
          final shown = harness.state;
          harness.tap((flow) => flow.tryAgain());
          expect(harness.state, shown);
          expect(harness.recorder.startedIdempotencyKeys, hasLength(1));
        });
      }
    });

    test(
      'T48: leaving Saved offline goes Home, and the clip stays queued (P6-OFFLINE-23, -28)',
      () {
        runFlowTest((harness) {
          identifyAndAnswer(
            harness,
            () => harness.adapter.failWithDioType(DioExceptionType.connectionError),
          );
          expect(harness.state, isA<SavedOfflineState>());
          harness.tap((flow) => flow.backToHome());
          expect(harness.state, const IdleState());
          _expectTheClipInTheOutbox(harness, savedReason: DeferredClipSavedReason.noConnection);
        });
      },
    );

    test(
      'a sixth clip saved with no signal deletes the oldest waiting one, and says so (P6-D6)',
      () {
        runFlowTest((harness) {
          for (var clip = 1; clip <= 6; clip++) {
            identifyAndAnswer(
              harness,
              () => harness.adapter.failWithDioType(DioExceptionType.connectionError),
            );
            expect(
              harness.state,
              SavedOfflineState(
                reason: SavedClipReason.noConnection,
                wasOldestClipDeleted: clip == 6,
              ),
              reason: 'clip $clip',
            );
            harness.tap((flow) => flow.backToHome());
            harness.wait(const Duration(minutes: 1));
          }
          final keys = harness.recorder.startedIdempotencyKeys;
          expect(
            harness.outboxItems.whereType<DeferredClipItem>().map((clip) => clip.idempotencyKey),
            keys.skip(1).toList(),
            reason: 'the first, the oldest, made room',
          );
        });
      },
    );

    test(
      'a clip the phone cannot keep is a failure on the phone, reported, and nothing is kept',
      () {
        runFlowTest(outboxStore: _BrokenOutboxStore(), (harness) {
          identifyAndAnswer(
            harness,
            () => harness.adapter.failWithDioType(DioExceptionType.connectionError),
          );
          expect(_failureOf(harness.state), isA<PhoneFailure>());
          expect(harness.reporter.reports.single.description, 'Keeping the clip for later failed');
          expect(harness.flow.hasKeptClip, isFalse);
        });
      },
    );

    for (final (name, scriptAnswer) in <(String, void Function(RecognitionFlowHarness))>[
      ('no match', (harness) => harness.answerWithResponseFixture('valid/no-match')),
      ('server failure', (harness) => harness.answerWithEnvelopeFixture('internal')),
      ('too many tries', (harness) => harness.answerWithEnvelopeFixture('rate-limited')),
      (
        'newer app needed',
        (harness) => harness.answerWithResponseFixture('invalid/ambiguous-status'),
      ),
      ('which station?', (harness) => harness.answerWithResponseFixture('valid/choose-station')),
      ('recording unusable', (harness) => harness.answerWithEnvelopeFixture('invalid-audio')),
      ('phone failure', (harness) => harness.recorder.finishError = StateError('no clip')),
      (
        'no connection',
        (harness) => harness.adapter.failWithDioType(DioExceptionType.connectionError),
      ),
    ]) {
      test('T38 Close ×, "Back to home" or system back from $name: idle, any clip deleted', () {
        runFlowTest((harness) {
          identifyAndAnswer(harness, () => scriptAnswer(harness));
          harness.tap((flow) => flow.backToHome());
          expect(harness.state, const IdleState());
          expect(harness.flow.hasKeptClip, isFalse);
          harness.wait(const Duration(minutes: 1));
          expect(harness.state, const IdleState());
          expect(harness.recognizeRequests.length, lessThanOrEqualTo(1));
        });
      });
    }

    test('T39 the phone failure report accepted: the code appears, from the accepted id', () {
      runFlowTest((harness) {
        harness.reporter.outcome = const ClientErrorReportAccepted(_acceptedReportId);
        harness.recorder.startError = StateError('microphone busy');
        harness.tap((flow) => flow.identify());
        final sending = harness.states.whereType<ErrorState>().first.failure as PhoneFailure;
        expect(sending.reportDelivery, ReportDelivery.sending);
        expect(sending.referenceCodeRequestId, isNull, reason: 'no code while sending');
        final failure = _failureOf(harness.state) as PhoneFailure;
        expect(failure.reportDelivery, ReportDelivery.accepted);
        expect(failure.referenceCodeRequestId, _acceptedReportId);
      });
    });

    for (final outcome in const [ClientErrorReportNotAccepted(), ClientErrorReportHeldBack()]) {
      test('T39 the phone failure report ${outcome.runtimeType}: no code', () {
        runFlowTest((harness) {
          harness.reporter.outcome = outcome;
          harness.recorder.startError = StateError('microphone busy');
          harness.tap((flow) => flow.identify());
          final failure = _failureOf(harness.state) as PhoneFailure;
          expect(failure.reportDelivery, ReportDelivery.notAccepted);
          expect(failure.referenceCodeRequestId, isNull);
        });
      });
    }

    test('T39 a report answered after the listener left changes nothing', () {
      final reporter = _HeldClientErrorReporter()
        ..outcome = const ClientErrorReportAccepted(_acceptedReportId);
      runFlowTest(reporter: reporter, (harness) {
        harness.recorder.startError = StateError('microphone busy');
        harness.tap((flow) => flow.identify());
        expect((_failureOf(harness.state) as PhoneFailure).reportDelivery, ReportDelivery.sending);
        harness.tap((flow) => flow.backToHome());
        reporter.release.complete();
        harness.settle();
        expect(harness.state, const IdleState());
      });
    });

    test('T40 "Copy" on the code: the flow keeps the error (the screen copies it)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('internal'));
        final shown = harness.state;
        harness.wait(const Duration(minutes: 5));
        expect(harness.state, same(shown));
        expect(
          _failureOf(shown).referenceCodeRequestId,
          RecognitionFlowHarness.envelopeRequestId('internal'),
        );
      });
    });

    test('T41 another identify in any state but idle is ignored', () {
      final reachers = <String, void Function(RecognitionFlowHarness)>{
        'permissionNeeded': (harness) {
          harness.permission.access = MicrophoneAccess.notAskedYet;
          harness.tap((flow) => flow.identify());
        },
        'recording': (harness) => harness.tap((flow) => flow.identify()),
        'uploading': (harness) => identifyAndAnswer(harness, harness.adapter.waitUntilCancelled),
        'matched': (harness) => identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('valid/match-campaign'),
        ),
        'fallback': (harness) => identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('valid/match-client-default'),
        ),
        'noMatch': (harness) =>
            identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match')),
        'busy': (harness) =>
            identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('recognition-busy')),
        'error': (harness) =>
            identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('internal')),
      };
      for (final MapEntry(key: name, value: reach) in reachers.entries) {
        runFlowTest((harness) {
          reach(harness);
          final shown = harness.state;
          final startCount = harness.recorder.startedIdempotencyKeys.length;
          final readCount = harness.permission.readCount;
          harness.tap((flow) => flow.identify());
          expect(harness.state, shown, reason: name);
          expect(harness.recorder.startedIdempotencyKeys, hasLength(startCount), reason: name);
          expect(harness.permission.readCount, readCount, reason: name);
        });
      }
    });

    test('T41 a double tap on Home starts one identify', () {
      runFlowTest((harness) {
        unawaited(harness.flow.identify());
        unawaited(harness.flow.identify());
        harness.settle();
        expect(harness.permission.readCount, 1);
        expect(harness.recorder.startedIdempotencyKeys, hasLength(1));
      });
    });
  });

  group('Which station? (P6 design §2.6, §2.17)', () {
    test('T1′ "My station" set: the request carries it as station_hint (P6-MYSTATION-05)', () {
      runFlowTest(storedPreferences: {MyStationStore.myStationKey: _stationAStored}, (harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(_sentHints(harness), [_stationAId]);
      });
    });

    test('T1′ no "My station": the request has no station_hint at all (P6-MYSTATION-05)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(_sentHints(harness), [null]);
        final fieldNames = ReceivedMultipartForm.of(
          harness.recognizeRequests.single,
        ).textFields.map((field) => field.key);
        expect(fieldNames, isNot(contains('station_hint')));
      });
    });

    test('T1′ every resend of a clip carries the hint it was captured with', () {
      runFlowTest(storedPreferences: {MyStationStore.myStationKey: _stationAStored}, (harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithEnvelopeFixture('recognition-busy', retryAfter: '2'),
        );
        expect(harness.state, isA<BusyState>());
        // "My station" changes while the clip waits on Busy.
        unawaited(
          MyStationStore().remember(
            const ListenerStation(id: _stationBId, name: 'Station B', frequencyLabel: '104.3 FM'),
          ),
        );
        harness.settle();
        harness.answerWithResponseFixture('valid/no-match');
        harness.wait(const Duration(seconds: 2));
        expect(harness.state, const NoMatchState());
        expect(_sentHints(harness), [_stationAId, _stationAId]);
      });
    });

    test('T1′ the hint is read when recording starts, never again for that clip', () {
      runFlowTest(storedPreferences: {MyStationStore.myStationKey: _stationAStored}, (harness) {
        harness.answerWithResponseFixture('valid/no-match');
        harness.tap((flow) => flow.identify());
        harness.wait(const Duration(seconds: 3));
        unawaited(
          MyStationStore().remember(
            const ListenerStation(id: _stationBId, name: 'Station B', frequencyLabel: '104.3 FM'),
          ),
        );
        harness.settle();
        harness.wait(const Duration(seconds: 5));
        expect(harness.state, const NoMatchState());
        expect(_sentHints(harness), [_stationAId]);

        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(_sentHints(harness), [_stationAId, _stationBId]);
      });
    });

    test('T44 a row shows that station\'s card at once, "via" it, with no request '
        '(P6-CHOOSER-09)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        final requestCount = harness.adapter.requests.length;

        harness.flow.chooseStation(stationId: _stationBId, isRemembered: true);
        // Synchronously, before anything else runs: the Result needs nothing from the network.
        final shown = harness.state as MatchedState;
        expect(shown.result.stationName, 'Station B');
        expect(shown.result.stationFrequencyLabel, '104.3 FM');
        expect(shown.result.stationCity, 'Kitwe');
        expect(shown.result.card.shownActions.first.id, '0192a6c4-0000-4000-8000-000000000011');
        harness.settle();
        expect(harness.adapter.requests, hasLength(requestCount), reason: 'no request at all');
        expect(harness.state, same(shown));
      });
    });

    test('T44 a default-card candidate shows the fallback result', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('valid/choose-station-out-of-window'),
        );
        final chooser = harness.state as ChooseStationState;
        expect(chooser.areAllCandidatesDefaultCards, isTrue);
        harness.tap(
          (flow) =>
              flow.chooseStation(stationId: chooser.candidates.last.stationId, isRemembered: false),
        );
        expect(harness.state, isA<FallbackState>());
        expect((harness.state as FallbackState).result.kind, RecognitionResultKind.clientDefault);
      });
    });

    test('T44 the choice is queued in the outbox once: the recognition and the tapped station '
        '(P6-CHOOSER-10)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: false));
        final item = harness.outboxItems.single as StationChoiceItem;
        expect(item.recognitionId, _chooserRecognitionId);
        expect(item.stationId, _stationBId);
        expect(item.kind, OutboxItemKind.stationChoice);
        expect(item.attemptCount, 0);
        expect(item.nextAttemptAt, isNull);
        // A second tap while the Result shows changes nothing: one choice per recognition.
        harness.tap((flow) => flow.chooseStation(stationId: _stationAId, isRemembered: false));
        expect(harness.outboxItems, hasLength(1));
        expect((harness.state as MatchedState).result.stationName, 'Station B');
      });
    });

    test(
      'T44 "Remember" ticked: the chosen station is My station and the next hint (P6-CHOOSER-07)',
      () {
        runFlowTest(storedPreferences: {MyStationStore.myStationKey: _stationAStored}, (harness) {
          identifyAndAnswer(
            harness,
            () => harness.answerWithResponseFixture('valid/choose-station'),
          );
          harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: true));
          expect(
            harness.storedPreference(MyStationStore.myStationKey),
            '{"id":"$_stationBId","name":"Station B","frequency_label":"104.3 FM","city":"Kitwe"}',
          );
          harness.tap((flow) => flow.backToHome());
          identifyAndAnswer(
            harness,
            () => harness.answerWithResponseFixture('valid/match-campaign-station-b'),
          );
          expect(_sentHints(harness), [_stationAId, _stationBId]);
        });
      },
    );

    test('T44 "Remember" unticked: "My station" stays as it was, and so does the hint '
        '(P6-CHOOSER-08)', () {
      runFlowTest(storedPreferences: {MyStationStore.myStationKey: _stationAStored}, (harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: false));
        expect(harness.storedPreference(MyStationStore.myStationKey), _stationAStored);
        expect(harness.outboxItems, hasLength(1), reason: 'the choice is queued all the same');
        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(_sentHints(harness), [_stationAId, _stationAId]);
      });
    });

    test('T44 "Remember" unticked with no station set: still none', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.chooseStation(stationId: _stationAId, isRemembered: false));
        expect(harness.storedPreference(MyStationStore.myStationKey), isNull);
      });
    });

    test('T44 a station the chooser does not offer, or a tap outside the chooser, is ignored', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: true));
        expect(harness.state, const IdleState());
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap(
          (flow) => flow.chooseStation(
            stationId: '0192a6c4-1111-4000-8000-000000000009',
            isRemembered: true,
          ),
        );
        expect(harness.state, isA<ChooseStationState>());
        expect(harness.outboxItems, isEmpty);
        expect(harness.storedPreference(MyStationStore.myStationKey), isNull);
      });
    });

    test('T46 Cancel: Home, nothing queued, nothing remembered (P6-CHOOSER-14)', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.outboxItems, isEmpty);
        expect(harness.storedPreference(MyStationStore.myStationKey), isNull);
        expect(harness.adapter.requests, hasLength(1), reason: 'no cancel request (gap 28)');
      });
    });

    test('a choice the phone cannot keep is reported, and the Result still shows', () {
      runFlowTest(outboxStore: _BrokenOutboxStore(), (harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: false));
        expect(harness.state, isA<MatchedState>());
        expect(harness.reporter.reports.single.description, 'Queueing the station choice failed');
      });
    });
  });

  group('a saved chooser opened from History or its notification (T51; P6 design §3.11)', () {
    Map<String, Object?> chooserAnswer() =>
        (ContractFixtures.readFile('recognition/recognize-response/valid/choose-station.json')!
                as Map<String, Object?>)['response']!
            as Map<String, Object?>;
    final capturedAt = DateTime.utc(2026, 10, 8, 9, 30);

    void openSaved(RecognitionFlowHarness harness, {List<RecognitionResult>? candidates}) {
      final answer = chooserAnswer();
      harness.tap(
        (flow) => flow.openSavedChooser(
          recognitionId: _chooserRecognitionId,
          candidates: candidates ?? const HistoryAnswerReader().readCandidates(answer)!,
          answer: answer,
          capturedAtOnPhone: capturedAt,
        ),
      );
    }

    test('opens "Which station?" from the stored candidates, with no request', () {
      runFlowTest((harness) {
        openSaved(harness);
        final chooser = harness.state as ChooseStationState;
        expect(chooser.origin, ChooserOrigin.savedRecognition);
        expect(chooser.recognitionId, _chooserRecognitionId);
        expect(chooser.candidates.map((candidate) => candidate.stationId), [
          _stationAId,
          _stationBId,
        ]);
        expect(harness.adapter.requests, isEmpty);
      });
    });

    test('a row shows that station\'s result at once, queues the choice, and History keeps the '
        'result with the clip\'s capture time', () {
      runFlowTest((harness) {
        openSaved(harness);
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: false));

        final shown = harness.state as MatchedState;
        expect(shown.result.stationName, 'Station B');
        final choice = harness.outboxItems.single as StationChoiceItem;
        expect(choice.recognitionId, _chooserRecognitionId);
        expect(choice.stationId, _stationBId);
        final kept = harness.historyView.resultFor(_chooserRecognitionId)!;
        expect(kept.result.stationId, _stationBId);
        expect(kept.capturedAtOnPhone, capturedAt);
        expect(harness.adapter.requests, isEmpty, reason: 'the choice goes through the outbox');
      });
    });

    test('Cancel goes back with nothing queued and nothing kept', () {
      runFlowTest((harness) {
        openSaved(harness);
        harness.tap((flow) => flow.backToHome());
        expect(harness.state, const IdleState());
        expect(harness.outboxItems, isEmpty);
        expect(harness.historyView.entries, isEmpty);
      });
    });

    test('ignored during an identify, and with fewer than two stations', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        expect(harness.state, isA<RecordingState>());
        openSaved(harness);
        expect(harness.state, isA<RecordingState>());
        harness.tap((flow) => flow.backToHome());

        final candidates = const HistoryAnswerReader().readCandidates(chooserAnswer())!;
        openSaved(harness, candidates: candidates.take(1).toList());
        expect(harness.state, const IdleState());
      });
    });
  });

  group('History (P6 design §2.7, §3.14; P6-HISTORY-01, -14)', () {
    test('T16 a match is saved to History with its card and the phone\'s capture time', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        final capturedAt = harness.clock.now();
        harness.answerWithResponseFixture('valid/match-campaign');
        harness.wait(const Duration(seconds: 8));
        expect(harness.state, isA<MatchedState>());

        final entry = harness.historyView.resultFor(_savedRecognitionId)!;
        expect(entry.capturedAtOnPhone, capturedAt.toUtc());
        expect(entry.result.clientName, 'Brand A');
        expect(entry.result.stationName, 'Station A');
        expect(entry.result.card.shownActions, hasLength(4));
        expect(harness.reporter.reports, isEmpty);
      });
    });

    test('T17 the advertiser\'s usual card is saved as such', () {
      runFlowTest((harness) {
        identifyAndAnswer(
          harness,
          () => harness.answerWithResponseFixture('valid/match-client-default'),
        );
        expect(harness.state, isA<FallbackState>());
        expect(
          harness.historyView.resultFor(_savedRecognitionId)!.result.kind,
          RecognitionResultKind.clientDefault,
        );
      });
    });

    test('T44 a chosen station is saved with its own card, once a row is tapped', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        expect(harness.historyView.isEmpty, isTrue, reason: 'nothing before the choice');
        harness.tap((flow) => flow.chooseStation(stationId: _stationBId, isRemembered: false));
        final entry = harness.historyView.resultFor(_savedRecognitionId)!;
        expect(entry.result.stationId, _stationBId);
        expect(entry.result.stationName, 'Station B');
      });
    });

    test('T46 Cancel on the chooser saves nothing, and nor does the next identify', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/choose-station'));
        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(harness.historyView.isEmpty, isTrue);
      });
    });

    test('no match, an error or a busy answer saves nothing', () {
      runFlowTest((harness) {
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('internal'));
        harness.tap((flow) => flow.backToHome());
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('recognition-busy'));
        expect(harness.state, isA<BusyState>());
        expect(harness.historyView.isEmpty, isTrue);
      });
    });

    test('a save the phone cannot make is reported quietly, and the Result still shows', () {
      runFlowTest((harness) {
        // A file where History's folder should be: the phone cannot write History.
        harness.historyFolder.deleteSync(recursive: true);
        File(harness.historyFolder.path).writeAsStringSync('in the way');
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/match-campaign'));
        expect(harness.state, isA<MatchedState>());
        expect(harness.reporter.reports.single.description, 'Saving the result to History failed');
        File(harness.historyFolder.path).deleteSync();
      });
    });
  });

  group('the clip files (S4-D7)', () {
    test('leftovers are swept at start and on every return to Home', () {
      runFlowTest((harness) {
        expect(harness.recorder.leftoverSweepCount, 1);
        harness.recorder.leaveClipFileBehind('left-by-a-crash.m4a');
        identifyAndAnswer(harness, () => harness.answerWithResponseFixture('valid/no-match'));
        expect(harness.recorder.clipFileNames, {'left-by-a-crash.m4a'});
        harness.tap((flow) => flow.backToHome());
        expect(harness.recorder.leftoverSweepCount, 2);
        expect(harness.recorder.clipFileNames, isEmpty);
      });
    });

    test('no clip file outlives its recording, whatever the way out', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        expect(harness.recorder.clipFileNames, hasLength(1));
        harness.tap((flow) => flow.backToHome());
        expect(harness.recorder.clipFileNames, isEmpty);
        identifyAndAnswer(harness, () => harness.answerWithEnvelopeFixture('recognition-busy'));
        expect(harness.recorder.clipFileNames, isEmpty, reason: 'kept in memory, not on disk');
      });
    });

    test('the flow ends cleanly: disposing it cancels a recording', () {
      runFlowTest((harness) {
        harness.tap((flow) => flow.identify());
        harness.container.invalidate(recognitionFlowProvider);
        harness.settle();
        expect(harness.recorder.cancelCount, 1);
        expect(harness.state, const IdleState());
      });
    });
  });
}

/// The outbox holds exactly the clip the flow recorded: its key, its recording byte for byte, the
/// capture time and hint the live send carried, and why it was kept (contract R1).
void _expectTheClipInTheOutbox(
  RecognitionFlowHarness harness, {
  required DeferredClipSavedReason savedReason,
}) {
  final clip = harness.outboxItems.whereType<DeferredClipItem>().single;
  final firstSend = ReceivedMultipartForm.of(harness.recognizeRequests.first);
  expect(clip.idempotencyKey, firstSend.fieldValues['idempotency_key']);
  expect(
    RecognizeRequestBuilder.formatUtcTimestamp(clip.capturedAt),
    firstSend.fieldValues['captured_at'],
  );
  expect(clip.stationHintId, firstSend.fieldValues['station_hint']);
  expect(clip.savedReason, savedReason);
  final recording = File(
    '${harness.outboxFolder.path}/clips/${clip.audioFileName}',
  ).readAsBytesSync();
  expect(recording, firstSend.fileParts.single.bytes);
  expect(clip.audioSizeBytes, recording.length);
}
