import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder.dart';
import 'package:lookup_listener/features/identify/domain/audio_codec.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:record/record.dart';

import '../../../support/repository_file_locator.dart';
import 'fake_record_platform.dart';

const String _idempotencyKey = '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a';

void main() {
  late FakeRecordPlatform platform;
  late RecordPlatform originalPlatform;
  late Directory temporaryFolder;
  late RecordClipRecorder recorder;

  Directory clipsFolder() => Directory(
    '${temporaryFolder.path}${Platform.pathSeparator}${RecordClipRecorder.clipsFolderName}',
  );

  List<String> clipFileNames() => clipsFolder().existsSync()
      ? [for (final entry in clipsFolder().listSync()) entry.uri.pathSegments.last]
      : const [];

  setUp(() {
    originalPlatform = RecordPlatform.instance;
    platform = FakeRecordPlatform();
    RecordPlatform.instance = platform;
    temporaryFolder = Directory.systemTemp.createTempSync('lookup_clip_recorder_test');
    recorder = RecordClipRecorder(readTemporaryDirectory: () async => temporaryFolder);
  });

  tearDown(() {
    RecordPlatform.instance = originalPlatform;
    temporaryFolder.deleteSync(recursive: true);
  });

  group('the recorder settings (S4-D6, §3.15)', () {
    test('are exactly AAC-LC, 16 kHz, mono, 24 kbit/s, effects off, the mic source', () {
      final config = RecordClipRecorder.recordConfigFor(ClipSettings.standard);
      expect(config.encoder, AudioEncoder.aacLc);
      expect(config.sampleRate, 16000);
      expect(config.numChannels, 1);
      expect(config.bitRate, 24000);
      expect(config.noiseSuppress, isFalse);
      expect(config.autoGain, isFalse);
      expect(config.echoCancel, isFalse);
      expect(config.device, isNull);
      expect(config.androidConfig.audioSource, AndroidAudioSource.mic);
      expect(config.androidConfig.manageBluetooth, isFalse);
      expect(config.androidConfig.muteAudio, isFalse);
      expect(config.androidConfig.toMap()['service'], isNull, reason: 'no recording service');
    });

    test(
      'leave other audio playing and keep the phone microphone, on Android and iOS (S4-D34)',
      () {
        final config = RecordClipRecorder.recordConfigFor(ClipSettings.standard);
        // Any other mode makes record_android take the audio focus for good, pausing the radio app
        // the listener is identifying.
        expect(config.audioInterruption, AudioInterruptionMode.none);
        expect(config.androidConfig.manageBluetooth, isFalse);
        // iOS: mix with what is playing and keep it on the speaker; no Bluetooth microphone.
        expect(config.iosConfig.categoryOptions, [
          IosAudioCategoryOption.mixWithOthers,
          IosAudioCategoryOption.defaultToSpeaker,
        ]);
        expect(
          config.toMap()['iosConfig'],
          containsPair('categoryOptions', 'mixWithOthers,defaultToSpeaker'),
          reason: 'what the platform side receives',
        );
      },
    );

    test('the AAC codec is recorded with the AAC-LC encoder, never Opus', () {
      for (final codec in AudioCodec.values) {
        expect(RecordClipRecorder.encoderFor(codec), AudioEncoder.aacLc);
      }
    });

    test('a started clip goes to the platform with those settings', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final sent = platform.startedConfigs.single.toMap();
      expect(sent, RecordClipRecorder.recordConfigFor(ClipSettings.standard).toMap());
      await recording.cancel();
    });
  });

  group('the clip file (S4-D7)', () {
    test('is <cache>/clips/<idempotency key>.m4a while recording', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      expect(
        platform.startedPaths.single,
        '${clipsFolder().path}${Platform.pathSeparator}$_idempotencyKey.m4a',
      );
      await recording.cancel();
    });

    test('finishing reads the bytes into memory and deletes the file at once', () async {
      platform.clipBytes = Uint8List.fromList(List<int>.generate(24000, (index) => index % 251));
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final audioBytes = await recording.finish();
      expect(audioBytes, platform.clipBytes);
      expect(clipFileNames(), isEmpty);
      expect(platform.stopCount, 1);
      expect(platform.disposedRecorderIds, hasLength(1), reason: 'the microphone is released');
    });

    test('cancelling deletes the partial file even when the platform leaves it', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await File(platform.startedPaths.single).writeAsBytes(const [1, 2, 3]);
      await recording.cancel();
      expect(platform.cancelCount, 1);
      expect(clipFileNames(), isEmpty);
      expect(platform.disposedRecorderIds, hasLength(1));
    });

    test('a missing clip file is a failure (T14)', () async {
      platform.writesNoFile = true;
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await expectLater(recording.finish(), throwsA(isA<ClipRecorderFailure>()));
      expect(platform.disposedRecorderIds, hasLength(1));
    });

    test('an empty clip file is a failure, and the file is deleted all the same (T14)', () async {
      platform.clipBytes = Uint8List(0);
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await expectLater(recording.finish(), throwsA(isA<ClipRecorderFailure>()));
      expect(clipFileNames(), isEmpty);
    });

    test('a key that is not a lower-case UUID can never name a file', () async {
      for (final key in ['../escape', 'CLIP', '3B9E7C1A-5D2F-4E8B-9A6C-1F0D2E3C4B5A', '']) {
        await expectLater(
          recorder.start(idempotencyKey: key, settings: ClipSettings.standard),
          throwsA(isA<ClipRecorderFailure>()),
        );
      }
      expect(platform.startedPaths, isEmpty);
    });
  });

  group('starting', () {
    test('a phone with no AAC-LC encoder cannot start, and nothing is left behind (T14)', () async {
      platform.isAacSupported = false;
      await expectLater(
        recorder.start(idempotencyKey: _idempotencyKey, settings: ClipSettings.standard),
        throwsA(isA<ClipRecorderFailure>()),
      );
      expect(platform.startedPaths, isEmpty);
      expect(clipFileNames(), isEmpty);
      expect(platform.disposedRecorderIds, hasLength(1));
    });

    test('a platform failure on start is thrown to the flow and the recorder released', () async {
      platform.startError = StateError('microphone busy');
      await expectLater(
        recorder.start(idempotencyKey: _idempotencyKey, settings: ClipSettings.standard),
        throwsA(isA<StateError>()),
      );
      expect(platform.disposedRecorderIds, hasLength(1));
    });

    test(
      'each clip gets a new platform recorder, so the microphone is released after it',
      () async {
        for (var count = 0; count < 2; count++) {
          final recording = await recorder.start(
            idempotencyKey: _idempotencyKey,
            settings: ClipSettings.standard,
          );
          await recording.finish();
        }
        expect(platform.createdRecorderIds, hasLength(2));
        expect(platform.disposedRecorderIds, platform.createdRecorderIds);
      },
    );
  });

  group('leftover clips (S4-D7)', () {
    test('are swept, but never the clip being recorded', () async {
      clipsFolder().createSync(recursive: true);
      for (final name in ['left-from-a-crash.m4a', 'another.m4a']) {
        File('${clipsFolder().path}${Platform.pathSeparator}$name').writeAsBytesSync(const [1]);
      }
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await File(platform.startedPaths.single).writeAsBytes(const [1, 2]);
      await recorder.deleteLeftoverClips();
      expect(clipFileNames(), ['$_idempotencyKey.m4a']);
      await recording.cancel();
      await recorder.deleteLeftoverClips();
      expect(clipFileNames(), isEmpty);
    });

    test('a sweep with no clips folder, or an unreadable cache, does not throw', () async {
      await recorder.deleteLeftoverClips();
      final failingRecorder = RecordClipRecorder(
        readTemporaryDirectory: () async => throw const FileSystemException('no cache'),
      );
      await failingRecorder.deleteLeftoverClips();
    });
  });

  group('the level and interruptions', () {
    test('dBFS maps to a 0 to 1 level: -60 and below is silence, 0 is full', () {
      expect(RecordClipRecorder.levelFractionFor(-160), 0);
      expect(RecordClipRecorder.levelFractionFor(-60), 0);
      expect(RecordClipRecorder.levelFractionFor(-30), 0.5);
      expect(RecordClipRecorder.levelFractionFor(0), 1);
      expect(RecordClipRecorder.levelFractionFor(6), 1);
      expect(RecordClipRecorder.levelFractionFor(double.negativeInfinity), 0);
      expect(RecordClipRecorder.levelFractionFor(double.nan), 0);
    });

    test('the level is sampled every 100 ms while recording', () async {
      platform.currentDecibels = -15;
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final firstLevel = await recording.levelFractions.first.timeout(const Duration(seconds: 2));
      expect(firstLevel, 0.75);
      await recording.cancel();
    });

    test('a call pausing the recorder is reported as an interruption (T13)', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final interrupted = recording.interruptions.first.timeout(const Duration(seconds: 2));
      // Let the recorder's state subscription settle before the call comes in.
      await Future<void>.delayed(const Duration(milliseconds: 10));
      platform.pauseForCall();
      await interrupted;
      await recording.cancel();
    });
  });

  group('a recorder that breaks while recording (T14)', () {
    /// Starts a clip and collects every failure it gives, once the recorder's state subscription
    /// has settled.
    Future<(ClipRecording, List<Object>)> startWatchingFailures() async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final failures = <Object>[];
      recording.failures.listen(null, onError: (Object error) => failures.add(error));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      return (recording, failures);
    }

    test('an error the platform reports is a failure at once, as it came', () async {
      final (recording, failures) = await startWatchingFailures();
      final error = StateError('the encoder failed');
      platform.failWhileRecording(error);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(failures, [same(error)]);
      await recording.cancel();
    });

    test('the recorder stopping on its own before the clip ends is a failure at once', () async {
      final (recording, failures) = await startWatchingFailures();
      platform.stopOnItsOwn();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(failures, [isA<ClipRecorderFailure>()]);
      await recording.cancel();
      expect(clipFileNames(), isEmpty);
    });

    test('the stop that finishing or cancelling causes is never a failure', () async {
      final (finished, finishFailures) = await startWatchingFailures();
      await finished.finish();
      final (cancelled, cancelFailures) = await startWatchingFailures();
      platform.stopOnCancel = true;
      await cancelled.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(finishFailures, isEmpty);
      expect(cancelFailures, isEmpty);
    });

    test('a failure is never also an interruption', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      final interruptions = <void>[];
      final interruptionErrors = <Object>[];
      recording.interruptions.listen(
        interruptions.add,
        onError: (Object error) => interruptionErrors.add(error),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      platform.failWhileRecording(StateError('the encoder failed'));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(interruptions, isEmpty);
      expect(interruptionErrors, isEmpty);
      await recording.cancel();
    });
  });

  group('the microphone permission (§3.16)', () {
    test('the recorder never asks: hasPermission is never called', () async {
      final recording = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await recording.finish();
      final cancelled = await recorder.start(
        idempotencyKey: _idempotencyKey,
        settings: ClipSettings.standard,
      );
      await cancelled.cancel();
      expect(platform.hasPermissionCallCount, 0);
    });

    test('no file of the identify feature calls hasPermission', () {
      final featureFolder = Directory.fromUri(
        RepositoryFileLocator.mobileAppFolder('lib/features/identify').uri,
      );
      final callers = [
        for (final file in featureFolder.listSync(recursive: true).whereType<File>())
          if (file.path.endsWith('.dart') && file.readAsStringSync().contains('hasPermission('))
            file.path,
      ];
      expect(callers, isEmpty);
    });
  });
}
