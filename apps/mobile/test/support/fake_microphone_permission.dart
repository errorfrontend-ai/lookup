import 'dart:async';

import 'package:lookup_listener/features/identify/data/microphone_permission.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';

/// The microphone permission for tests (design §4.1): what the phone says is set by the test, and
/// every read, prompt and settings visit is counted, so a test can prove the system prompt shows
/// only after "Allow microphone", and only once.
class FakeMicrophonePermission implements MicrophonePermission {
  FakeMicrophonePermission({
    this.access = MicrophoneAccess.granted,
    this.answerToPrompt = MicrophoneAccess.granted,
  });

  /// What a read gives now. A prompt's answer becomes the new value, as on a phone.
  MicrophoneAccess access;

  /// What the listener answers in the system prompt.
  MicrophoneAccess answerToPrompt;

  /// Thrown by reads and by the prompt when set (the permission plugin failing).
  Object? readError;
  Object? promptError;

  /// When set, the prompt stays open until it completes, so a test can act meanwhile.
  Completer<void>? promptGate;

  /// What opening the phone's settings resolves to.
  bool opensSettings = true;

  int readCount = 0;
  int promptCount = 0;
  int settingsOpenCount = 0;

  @override
  Future<MicrophoneAccess> readAccess() async {
    readCount++;
    final error = readError;
    if (error != null) throw error;
    return access;
  }

  @override
  Future<MicrophoneAccess> requestAccess() async {
    promptCount++;
    final gate = promptGate;
    if (gate != null) await gate.future;
    final error = promptError;
    if (error != null) throw error;
    return access = answerToPrompt;
  }

  @override
  Future<bool> openSettings() async {
    settingsOpenCount++;
    return opensSettings;
  }
}
