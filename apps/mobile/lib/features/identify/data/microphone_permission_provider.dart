import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission.dart';

export 'package:lookup_listener/features/identify/data/microphone_permission.dart'
    show MicrophonePermission;

/// The microphone permission the recognition flow reads and asks for (design §3.5). The flow reads
/// it through this file only, so the presentation layer never imports `package:permission_handler`
/// (S4-D2); tests override it with a fake.
final Provider<MicrophonePermission> microphonePermissionProvider = Provider<MicrophonePermission>(
  (ref) => PermissionHandlerMicrophonePermission(),
  // A failing provider is never rebuilt on its own: the flow decides what a failure means (S4-D4).
  retry: (retryCount, error) => null,
);
