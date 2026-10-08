import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:record/record.dart';

/// `record`'s platform side replaced for tests of `RecordClipRecorder`: it writes the scripted
/// clip to the path it was given when stopped, as the encoder would, and records every call, so a
/// test sees the exact settings sent and can prove `hasPermission` is never called.
///
/// Its `cancel` deliberately leaves the file in place, so the tests prove the app deletes it
/// itself rather than trusting the platform to.
class FakeRecordPlatform extends RecordPlatform {
  /// The bytes the "encoder" writes on stop; empty bytes stand for an empty file.
  Uint8List clipBytes = Uint8List.fromList(const [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

  /// When true, stopping writes no file at all.
  bool writesNoFile = false;

  /// When true, cancelling reports the stop it causes, as a real recorder can.
  bool stopOnCancel = false;

  bool isAacSupported = true;

  /// Thrown by [start] when set.
  Object? startError;

  /// The current dBFS reading the amplitude sampling gets.
  double currentDecibels = -30;

  final List<RecordConfig> startedConfigs = [];
  final List<String> startedPaths = [];
  final Set<String> createdRecorderIds = {};
  final Set<String> disposedRecorderIds = {};
  int stopCount = 0;
  int cancelCount = 0;
  int hasPermissionCallCount = 0;

  final Map<String, StreamController<RecordState>> _stateControllers = {};
  final Map<String, String> _pathsByRecorder = {};
  final Set<String> _recordingIds = {};

  /// The platform pauses every recording.
  void pauseForCall() {
    for (final controller in _stateControllers.values) {
      controller.add(RecordState.pause);
    }
  }

  /// Every recording breaks: the platform reports [error] on the state stream, as `record_android`
  /// does when its encoder or microphone fails.
  void failWhileRecording(Object error) {
    for (final controller in _stateControllers.values) {
      controller.addError(error);
    }
  }

  /// Every recording stops on its own, with nobody asking (after a failure, or the system taking
  /// the microphone).
  void stopOnItsOwn() {
    for (final controller in _stateControllers.values) {
      controller.add(RecordState.stop);
    }
  }

  StreamController<RecordState> _stateController(String recorderId) =>
      _stateControllers.putIfAbsent(recorderId, () => StreamController<RecordState>.broadcast());

  @override
  Future<void> create(String recorderId) async => createdRecorderIds.add(recorderId);

  @override
  Future<void> start(String recorderId, RecordConfig config, {required String path}) async {
    final error = startError;
    if (error != null) throw error;
    startedConfigs.add(config);
    startedPaths.add(path);
    _pathsByRecorder[recorderId] = path;
    _recordingIds.add(recorderId);
    _stateController(recorderId).add(RecordState.record);
  }

  @override
  Future<String?> stop(String recorderId) async {
    stopCount++;
    _recordingIds.remove(recorderId);
    final path = _pathsByRecorder[recorderId];
    if (path == null) return null;
    if (!writesNoFile) await File(path).writeAsBytes(clipBytes);
    _stateController(recorderId).add(RecordState.stop);
    return path;
  }

  @override
  Future<void> cancel(String recorderId) async {
    cancelCount++;
    _recordingIds.remove(recorderId);
    if (stopOnCancel) _stateController(recorderId).add(RecordState.stop);
  }

  @override
  Future<void> dispose(String recorderId) async {
    disposedRecorderIds.add(recorderId);
    _recordingIds.remove(recorderId);
    await _stateControllers.remove(recorderId)?.close();
  }

  @override
  Future<bool> hasPermission(String recorderId, {bool request = true}) async {
    hasPermissionCallCount++;
    return true;
  }

  @override
  Future<bool> isEncoderSupported(String recorderId, AudioEncoder encoder) async =>
      encoder == AudioEncoder.aacLc && isAacSupported;

  @override
  Future<bool> isRecording(String recorderId) async => _recordingIds.contains(recorderId);

  @override
  Future<bool> isPaused(String recorderId) async => false;

  @override
  Future<Amplitude> getAmplitude(String recorderId) async =>
      Amplitude(current: currentDecibels, max: currentDecibels);

  @override
  Stream<RecordState> onStateChanged(String recorderId) => _stateController(recorderId).stream;

  @override
  Future<Stream<Uint8List>> startStream(String recorderId, RecordConfig config) =>
      throw UnsupportedError('The app records to a file, never to a stream.');

  @override
  Future<void> pause(String recorderId) =>
      throw UnsupportedError('The app never pauses a recording itself.');

  @override
  Future<void> resume(String recorderId) =>
      throw UnsupportedError('The app never resumes a recording itself.');

  @override
  Future<List<InputDevice>> listInputDevices(String recorderId) async => const [];
}
