import 'dart:async';
import 'dart:typed_data';

import 'package:lookup_listener/features/identify/data/clip_recorder.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

/// A microphone for tests (design §4.1): no platform, scripted levels and an M4A-shaped clip.
///
/// It keeps its clip "files" as a set of names, as the real recorder keeps them in `<cache>/clips`,
/// so tests can check that a clip file never outlives its recording: added on start, removed when
/// the clip is read (finish) or cancelled, and removed by a sweep unless it is being recorded.
/// Levels are sent on a timer every 100 ms while recording, so they follow `fake_async` time.
class FakeClipRecorder implements ClipRecorder {
  /// [levelFractions] are sent in turn, then from the start again; [clipBytes] is what every clip
  /// reads as, by default [m4aShapedClip].
  FakeClipRecorder({this.levelFractions = const [0.25, 0.5, 0.75, 1.0], Uint8List? clipBytes})
    : clipBytes = clipBytes ?? m4aShapedClip();

  /// How often the real recorder samples the level.
  static const Duration levelInterval = Duration(milliseconds: 100);

  final List<double> levelFractions;

  /// What [ClipRecording.finish] gives.
  Uint8List clipBytes;

  /// Thrown by the next [start] when set (a recorder that cannot start, T14).
  Object? startError;

  /// Thrown by [ClipRecording.finish] when set (a recorder that cannot finish, T14).
  Object? finishError;

  /// When set, [start] waits for it, so a test can act while the microphone is opening.
  Completer<void>? startGate;

  /// The idempotency key of every clip started, in order.
  final List<String> startedIdempotencyKeys = [];

  /// The settings every clip was started with.
  final List<ClipSettings> startedSettings = [];

  int finishCount = 0;
  int cancelCount = 0;
  int leftoverSweepCount = 0;

  /// The clip files that exist now, by name.
  final Set<String> clipFileNames = {};

  /// The recording under way, if any.
  FakeClipRecording? currentRecording;

  /// Whether a recording is under way.
  bool get isRecording => currentRecording?.hasEnded == false;

  /// A clip file a crashed earlier run left behind.
  void leaveClipFileBehind(String name) => clipFileNames.add(name);

  /// The system pauses the recorder (a call, another app taking the microphone).
  void interrupt() => currentRecording!._interruptions.add(null);

  @override
  Future<ClipRecording> start({
    required String idempotencyKey,
    required ClipSettings settings,
  }) async {
    startedIdempotencyKeys.add(idempotencyKey);
    startedSettings.add(settings);
    final gate = startGate;
    if (gate != null) await gate.future;
    final error = startError;
    if (error != null) throw error;
    final fileName = '$idempotencyKey.m4a';
    clipFileNames.add(fileName);
    return currentRecording = FakeClipRecording._(this, fileName);
  }

  @override
  Future<void> deleteLeftoverClips() async {
    leftoverSweepCount++;
    final recordingFileName = isRecording ? currentRecording!.fileName : null;
    clipFileNames.removeWhere((name) => name != recordingFileName);
  }

  /// A clip shaped like AAC-LC in MP4, as the API checks it: an `ftyp` box (`M4A `) first, then an
  /// `mdat` box of [sizeBytes] in all, about what 8 seconds at 24 kbit/s make. The payload bytes
  /// stay below 0x80, so the body can also be read as text in tests.
  static Uint8List m4aShapedClip({int sizeBytes = 24000}) {
    const fileTypeBox = [
      0x00, 0x00, 0x00, 0x18, // box size, 24
      0x66, 0x74, 0x79, 0x70, // "ftyp"
      0x4d, 0x34, 0x41, 0x20, // major brand "M4A "
      0x00, 0x00, 0x00, 0x00, // minor version
      0x4d, 0x34, 0x41, 0x20, // compatible brand "M4A "
      0x69, 0x73, 0x6f, 0x6d, // compatible brand "isom"
    ];
    final mediaDataSize = sizeBytes - fileTypeBox.length;
    return Uint8List.fromList([
      ...fileTypeBox,
      (mediaDataSize >> 24) & 0xff,
      (mediaDataSize >> 16) & 0xff,
      (mediaDataSize >> 8) & 0xff,
      mediaDataSize & 0xff,
      0x6d, 0x64, 0x61, 0x74, // "mdat"
      for (var index = 0; index < mediaDataSize - 8; index++) 0x20 + index % 0x5f,
    ]);
  }
}

/// One fake recording.
class FakeClipRecording implements ClipRecording {
  FakeClipRecording._(this._recorder, this.fileName) {
    _levelTimer = Timer.periodic(FakeClipRecorder.levelInterval, (timer) {
      final levels = _recorder.levelFractions;
      if (levels.isNotEmpty) _levels.add(levels[(timer.tick - 1) % levels.length]);
    });
  }

  final FakeClipRecorder _recorder;

  /// The clip's file name, `<idempotency key>.m4a`.
  final String fileName;

  final StreamController<double> _levels = StreamController<double>.broadcast();
  final StreamController<void> _interruptions = StreamController<void>.broadcast();
  late final Timer _levelTimer;

  bool hasEnded = false;

  @override
  Stream<double> get levelFractions => _levels.stream;

  @override
  Stream<void> get interruptions => _interruptions.stream;

  @override
  Future<Uint8List> finish() async {
    _recorder.finishCount++;
    _end();
    final error = _recorder.finishError;
    if (error != null) throw error;
    return Uint8List.fromList(_recorder.clipBytes);
  }

  @override
  Future<void> cancel() async {
    _recorder.cancelCount++;
    _end();
  }

  /// The file is deleted as the clip is read or cancelled, and the microphone released.
  void _end() {
    if (hasEnded) return;
    hasEnded = true;
    _levelTimer.cancel();
    _recorder.clipFileNames.remove(fileName);
    unawaited(_levels.close());
    unawaited(_interruptions.close());
  }
}
