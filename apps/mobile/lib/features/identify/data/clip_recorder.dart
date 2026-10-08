import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:lookup_listener/features/identify/domain/audio_codec.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:path_provider/path_provider.dart' show getTemporaryDirectory;
import 'package:record/record.dart';

/// The microphone, as the recognition flow uses it: one clip at a time, recorded to a file that
/// lives only until its bytes are in memory (design §3.15, S4-D6, S4-D7).
///
/// An interface, so the flow is tested with scripted levels and bytes, and so nothing above the data
/// layer touches `package:record`. Only `RecognitionFlow` starts a recording, and only after a tap
/// (S4-PRIVACY-02). It never asks for the microphone permission: that is `MicrophonePermission`'s
/// job, and only after "Allow microphone" (S4-D22).
abstract interface class ClipRecorder {
  /// Starts recording a new clip named after [idempotencyKey], with [settings]. Throws when the
  /// recorder cannot start (no AAC encoder, the microphone busy, a platform failure); the flow shows
  /// that as a phone failure (T14).
  Future<ClipRecording> start({required String idempotencyKey, required ClipSettings settings});

  /// Deletes every clip file an earlier run left behind (a crash between stopping and deleting),
  /// except the one being recorded now. Called at start-up and on every return to Home. Never
  /// throws.
  Future<void> deleteLeftoverClips();
}

/// One recording in progress, from [ClipRecorder.start] until [finish] or [cancel].
abstract interface class ClipRecording {
  /// The live input level, 0 (silence) to 1, about every 100 ms, for the ring and the level bars.
  Stream<double> get levelFractions;

  /// An event each time the system pauses the recorder (a phone call, another app taking the
  /// microphone). The flow then cancels the clip (T13): a clip with a gap is not worth sending.
  Stream<void> get interruptions;

  /// Stops the recorder, reads the clip into memory and deletes the file at once. Throws when the
  /// clip is missing or empty (T14); the file is deleted either way.
  Future<Uint8List> finish();

  /// Stops the recorder and deletes the partial clip. Never throws.
  Future<void> cancel();
}

/// Why the recorder could not give a clip, in the app's own words for the crash report (never
/// shown: the Error screen has its own wording).
final class ClipRecorderFailure implements Exception {
  const ClipRecorderFailure(this.description);

  final String description;

  @override
  String toString() => 'ClipRecorderFailure: $description';
}

/// Records with `record` 6.2.1: AAC-LC in MP4, 16 kHz, mono, 24 kbit/s, every voice effect off,
/// the plain `mic` source (S4-D6). The Phase 0 capture app's settings, which ADR-001 measured at
/// 25.7 kB per 8 s; provisional until the pilot (gap 41).
///
/// - A new `AudioRecorder` per clip, disposed after it, so the microphone is released at once.
/// - The file is `<cache>/clips/<idempotency key>.m4a`; on finish its bytes are read into memory
///   and the file is deleted at once; on cancel it is deleted too (S4-D7).
/// - `record`'s `hasPermission` is never called: by default it would show the system prompt itself
///   and skip the explainer screen (§3.16).
final class RecordClipRecorder implements ClipRecorder {
  /// [createAudioRecorder] and [readTemporaryDirectory] are for tests; the app uses `record`'s
  /// recorder and `path_provider`'s cache folder.
  RecordClipRecorder({
    AudioRecorder Function()? createAudioRecorder,
    Future<Directory> Function()? readTemporaryDirectory,
  }) : _createAudioRecorder = createAudioRecorder ?? AudioRecorder.new,
       _readTemporaryDirectory = readTemporaryDirectory ?? getTemporaryDirectory;

  /// The folder under the cache that holds clips while they are recorded.
  static const String clipsFolderName = 'clips';

  /// The file extension: AAC-LC in an MP4 container.
  static const String clipFileExtension = '.m4a';

  /// How often the level is sampled for the ring and the bars (T9).
  static const Duration levelSamplingInterval = Duration(milliseconds: 100);

  /// The quietest level the ring shows above zero, in dBFS; anything quieter is silence.
  static const double quietestShownDecibels = -60;

  /// An idempotency key as the flow makes one: a lower-case UUID. Checked before it becomes a file
  /// name, so nothing else can name a path.
  static final RegExp _idempotencyKeyPattern = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );

  final AudioRecorder Function() _createAudioRecorder;
  final Future<Directory> Function() _readTemporaryDirectory;

  /// The files being recorded now, which a sweep must leave alone.
  final Set<String> _recordingPaths = {};

  /// The recorder's settings for [settings] (§3.15), exactly. The voice effects are set off here,
  /// in one place: a phone's noise suppression and automatic gain reshape the sound the
  /// fingerprints are matched on.
  static RecordConfig recordConfigFor(ClipSettings settings) => RecordConfig(
    encoder: encoderFor(settings.codec),
    sampleRate: settings.sampleRateHertz,
    numChannels: settings.channelCount,
    bitRate: settings.bitRateBitsPerSecond,
    noiseSuppress: false,
    autoGain: false,
    echoCancel: false,
    // A call pauses the recorder; the flow then cancels the clip (T13).
    audioInterruption: AudioInterruptionMode.pause,
    // `service` is left unset: no background recording service, ever (§3.17).
    androidConfig: const AndroidRecordConfig(
      audioSource: AndroidAudioSource.mic,
      // A paired headset must not replace the phone's own microphone.
      manageBluetooth: false,
      muteAudio: false,
    ),
  );

  /// `record`'s encoder for a codec: AAC-LC, which every Android version `record` supports has;
  /// never Opus, which `record_android` refuses below Android 10 (gap 40).
  static AudioEncoder encoderFor(AudioCodec codec) => switch (codec) {
    AudioCodec.aac => AudioEncoder.aacLc,
  };

  /// The level the screen shows for [decibels], the recorder's current dBFS: −60 dBFS and below
  /// (silence is −160) is 0, 0 dBFS is 1. A reading that is not a number is silence.
  static double levelFractionFor(double decibels) {
    if (decibels.isNaN) return 0;
    return ((decibels - quietestShownDecibels) / -quietestShownDecibels).clamp(0, 1).toDouble();
  }

  @override
  Future<ClipRecording> start({
    required String idempotencyKey,
    required ClipSettings settings,
  }) async {
    if (!_idempotencyKeyPattern.hasMatch(idempotencyKey)) {
      throw const ClipRecorderFailure('The clip key is not a lower-case UUID.');
    }
    final folder = await _clipsFolder();
    await folder.create(recursive: true);
    final file = File('${folder.path}${Platform.pathSeparator}$idempotencyKey$clipFileExtension');
    final recorder = _createAudioRecorder();
    _recordingPaths.add(file.path);
    try {
      if (!await recorder.isEncoderSupported(encoderFor(settings.codec))) {
        throw const ClipRecorderFailure('The phone has no AAC-LC encoder.');
      }
      final recording = _RecordClipRecording(
        recorder: recorder,
        file: file,
        onEnded: () => _recordingPaths.remove(file.path),
      );
      await recorder.start(recordConfigFor(settings), path: file.path);
      return recording;
    } on Object {
      _recordingPaths.remove(file.path);
      await _deleteQuietly(file);
      await _disposeQuietly(recorder);
      rethrow;
    }
  }

  @override
  Future<void> deleteLeftoverClips() async {
    try {
      final folder = await _clipsFolder();
      if (!await folder.exists()) return;
      await for (final entry in folder.list(followLinks: false)) {
        if (entry is File && !_recordingPaths.contains(entry.path)) await _deleteQuietly(entry);
      }
    } on Object {
      // The folder could not be read: the next start or return to Home sweeps again.
    }
  }

  Future<Directory> _clipsFolder() async {
    final temporaryFolder = await _readTemporaryDirectory();
    return Directory('${temporaryFolder.path}${Platform.pathSeparator}$clipsFolderName');
  }

  static Future<void> _deleteQuietly(File file) async {
    try {
      if (await file.exists()) await file.delete();
    } on Object {
      // Already gone, or held by the system: the next sweep deletes it.
    }
  }

  static Future<void> _disposeQuietly(AudioRecorder recorder) async {
    try {
      await recorder.dispose();
    } on Object {
      // The recorder is dropped either way; its platform side is released with the app.
    }
  }
}

/// One `record` recording and its file.
final class _RecordClipRecording implements ClipRecording {
  _RecordClipRecording({
    required AudioRecorder recorder,
    required File file,
    required void Function() onEnded,
  }) : _recorder = recorder,
       _file = file,
       _onEnded = onEnded;

  final AudioRecorder _recorder;
  final File _file;
  final void Function() _onEnded;
  bool _hasEnded = false;

  @override
  Stream<double> get levelFractions => _recorder
      .onAmplitudeChanged(RecordClipRecorder.levelSamplingInterval)
      .map((amplitude) => RecordClipRecorder.levelFractionFor(amplitude.current));

  @override
  Stream<void> get interruptions => _recorder
      .onStateChanged()
      .where((recordState) => recordState == RecordState.pause)
      .map<void>((_) {});

  @override
  Future<Uint8List> finish() async {
    try {
      await _recorder.stop();
      if (!await _file.exists()) {
        throw const ClipRecorderFailure('The recorder left no clip file.');
      }
      final audioBytes = await _file.readAsBytes();
      if (audioBytes.isEmpty) throw const ClipRecorderFailure('The recorded clip is empty.');
      return audioBytes;
    } finally {
      await _end();
    }
  }

  @override
  Future<void> cancel() async {
    try {
      await _recorder.cancel();
    } on Object {
      // Cancelling a recorder that already stopped or failed: the file is deleted below anyway.
    }
    await _end();
  }

  /// Deletes the file and releases the microphone, once.
  Future<void> _end() async {
    if (_hasEnded) return;
    _hasEnded = true;
    await RecordClipRecorder._deleteQuietly(_file);
    await RecordClipRecorder._disposeQuietly(_recorder);
    _onEnded();
  }
}
