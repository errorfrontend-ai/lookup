import 'dart:io' show pid;

import 'package:lookup_listener/core/files/owned_lock_file.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';

/// This Dart engine, as the lock files name it (P6 design §3.8, fact 9): a version-4 UUID made when
/// the engine starts, and the process it runs in.
///
/// Which engines of the process are still attached is the in-repo `device_services` plugin's to
/// say once a second engine exists (the background job of piece 3). Until then the app runs one
/// engine, so a lock of this process naming any other engine was left by one that has ended (a
/// hot restart during development), and [isEngineAttached] says so.
final class EngineIdentity {
  const EngineIdentity({required this.engineId, required this.processId});

  /// A new identity for the engine starting now.
  factory EngineIdentity.forThisEngine(RandomUuid randomUuid) =>
      EngineIdentity(engineId: randomUuid.generate(), processId: pid);

  final String engineId;
  final int processId;

  /// What this engine's lock files say.
  LockFileOwner get lockOwner => LockFileOwner(processId: processId, engineId: engineId);

  /// Whether the engine [engineId] of this process still runs.
  bool isEngineAttached(String engineId) => engineId == this.engineId;
}
