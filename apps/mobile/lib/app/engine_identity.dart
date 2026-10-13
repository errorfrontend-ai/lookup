import 'dart:io' show pid;

import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';

/// This Dart engine, as the lock files name it (P6 design §3.8, fact 9): a version-4 UUID made when
/// the engine starts, and the process it runs in. Which engines of the process are still attached is
/// the `device_services` plugin's to say (`lockTakeOverProvider`), as the app's engine and the
/// background job's can run in one process.
final class EngineIdentity {
  const EngineIdentity({required this.engineId, required this.processId});

  /// A new identity for the engine starting now.
  factory EngineIdentity.forThisEngine(RandomUuid randomUuid) =>
      EngineIdentity(engineId: randomUuid.generate(), processId: pid);

  final String engineId;
  final int processId;

  /// What this engine's lock files say.
  LockFileOwner get lockOwner => LockFileOwner(processId: processId, engineId: engineId);
}
