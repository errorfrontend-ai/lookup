import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/identify/data/clip_recorder.dart';

export 'package:lookup_listener/features/identify/data/clip_recorder.dart'
    show ClipRecorder, ClipRecording;

/// The microphone the recognition flow records with (design §3.5). The flow reads the recorder
/// through this file only, so the presentation layer never imports `package:record` (S4-D2); tests
/// override it with a fake that has scripted levels and bytes.
final Provider<ClipRecorder> clipRecorderProvider = Provider<ClipRecorder>(
  (ref) => RecordClipRecorder(),
  // A failing provider is never rebuilt on its own: the flow decides what a failure means (S4-D4).
  retry: (retryCount, error) => null,
);
