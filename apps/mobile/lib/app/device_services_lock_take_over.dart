import 'dart:io';

import 'package:device_services/device_services.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';

/// The lock files' take-over on Android (P6 design §3.8, §3.15): the `device_services` plugin keeps
/// the process's set of attached engines and judges and takes over a lock as one step for the whole
/// process, so a lock the background job's engine holds is never removed by the app's, or the
/// reverse. Where the plugin keeps no such record (iOS), this engine is the only one, and
/// [fallback] decides.
final class DeviceServicesLockTakeOver implements LockTakeOver {
  const DeviceServicesLockTakeOver({
    required DeviceServices deviceServices,
    required LockTakeOver fallback,
  }) : _deviceServices = deviceServices,
       _fallback = fallback;

  final DeviceServices _deviceServices;
  final LockTakeOver _fallback;

  @override
  Future<bool> takeOverDeadLock({
    required File file,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) async {
    final answer = await _deviceServices.takeOverDeadLock(
      path: file.path,
      expectedContent: expectedContent,
      askingEngineId: askingEngineId,
      ownerEngineId: ownerEngineId,
    );
    if (answer != null) return answer;
    return _fallback.takeOverDeadLock(
      file: file,
      expectedContent: expectedContent,
      askingEngineId: askingEngineId,
      ownerEngineId: ownerEngineId,
    );
  }
}
