import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/device_services_lock_take_over.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';

import '../support/fake_device_services.dart';

const String _thisEngine = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const String _otherEngine = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

/// A fake plugin whose answer to a take-over the test sets: null is "not supported" (iOS, or a
/// plugin that failed).
final class _AnsweringDeviceServices extends FakeDeviceServices {
  _AnsweringDeviceServices(this.answer);

  final bool? answer;
  final List<String?> askedAbout = [];

  @override
  Future<bool?> takeOverDeadLock({
    required String path,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) async {
    askedAbout.add(ownerEngineId);
    return answer;
  }
}

/// A lock take-over that records whether it was asked.
final class _RecordingTakeOver implements LockTakeOver {
  int calls = 0;

  @override
  Future<bool> takeOverDeadLock({
    required File file,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) async {
    calls++;
    return true;
  }
}

/// How the outbox's and History's lock files judge a lock another engine may hold (P6 design §3.8):
/// the plugin's one step for the whole process when it can answer, and this engine as the only one
/// when it cannot.
void main() {
  late Directory folder;
  late File lockFile;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('device_services_lock_take_over_test_');
    addTearDown(() => folder.deleteSync(recursive: true));
    lockFile = File('${folder.path}/index.lock')..writeAsStringSync('4242 $_otherEngine');
  });

  for (final answer in [true, false]) {
    test('the plugin\'s answer ($answer) decides, and the fallback is not asked', () async {
      final deviceServices = _AnsweringDeviceServices(answer);
      final fallback = _RecordingTakeOver();
      final takeOver = DeviceServicesLockTakeOver(
        deviceServices: deviceServices,
        fallback: fallback,
      );
      expect(
        await takeOver.takeOverDeadLock(
          file: lockFile,
          expectedContent: '4242 $_otherEngine',
          askingEngineId: _thisEngine,
          ownerEngineId: _otherEngine,
        ),
        answer,
      );
      expect(deviceServices.askedAbout, [_otherEngine]);
      expect(fallback.calls, 0);
    });
  }

  test('a plugin that cannot answer leaves it to the fallback', () async {
    final fallback = _RecordingTakeOver();
    final takeOver = DeviceServicesLockTakeOver(
      deviceServices: _AnsweringDeviceServices(null),
      fallback: fallback,
    );
    expect(
      await takeOver.takeOverDeadLock(
        file: lockFile,
        expectedContent: '4242 $_otherEngine',
        askingEngineId: _thisEngine,
        ownerEngineId: _otherEngine,
      ),
      isTrue,
    );
    expect(fallback.calls, 1);
  });

  test('with the plugin, a lock whose owner engine is still attached is never taken over, '
      'even an empty one (carried over from the review of piece 1)', () async {
    final deviceServices = FakeDeviceServices()
      ..attachedEngineIds.addAll({_thisEngine, _otherEngine});
    final takeOver = DeviceServicesLockTakeOver(
      deviceServices: deviceServices,
      fallback: LocalLockTakeOver(attachedEngineIds: {_thisEngine}),
    );
    lockFile.writeAsStringSync('');
    expect(
      await takeOver.takeOverDeadLock(
        file: lockFile,
        expectedContent: '',
        askingEngineId: _thisEngine,
        ownerEngineId: null,
      ),
      isFalse,
    );
    expect(lockFile.existsSync(), isTrue);
  });
}
