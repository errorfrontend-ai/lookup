import 'dart:async';
import 'dart:io';

import 'package:device_services/device_services.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';

/// One notification [FakeDeviceServices] was asked to post.
final class PostedNotification {
  const PostedNotification({
    required this.notificationId,
    required this.title,
    required this.text,
    required this.recognitionId,
    required this.channelName,
    required this.channelDescription,
  });

  final int notificationId;
  final String title;
  final String text;
  final String recognitionId;
  final String channelName;
  final String channelDescription;
}

/// The `device_services` plugin in tests (P6 design §4.1): the notifications it was asked to post,
/// the network the test sets, launch ids the test sends, and the attached engines the test controls.
class FakeDeviceServices implements DeviceServices {
  FakeDeviceServices({
    this.areNotificationsOn = true,
    bool isNetworkUp = true,
    this.isMetered = false,
  }) : _isNetworkUp = isNetworkUp;

  bool areNotificationsOn;
  bool isMetered;
  bool _isNetworkUp;
  final List<PostedNotification> posted = [];
  final Set<String> attachedEngineIds = {};
  String? pendingLaunchRecognitionId;
  final StreamController<bool> _network = StreamController<bool>.broadcast();
  final StreamController<String> _launches = StreamController<String>.broadcast();

  /// Sets the network, telling the listeners as Android would.
  void setNetwork({required bool isUp}) {
    _isNetworkUp = isUp;
    _network.add(isUp);
  }

  /// A notification's tap while the app runs.
  void tapNotification(String recognitionId) => _launches.add(recognitionId);

  @override
  Future<bool> areNotificationsEnabled() async => areNotificationsOn;

  @override
  Future<void> showSavedClipNotification({
    required int notificationId,
    required String title,
    required String text,
    required String recognitionId,
    required String channelName,
    required String channelDescription,
  }) async {
    posted.add(
      PostedNotification(
        notificationId: notificationId,
        title: title,
        text: text,
        recognitionId: recognitionId,
        channelName: channelName,
        channelDescription: channelDescription,
      ),
    );
  }

  @override
  Future<String?> takeLaunchRecognitionId() async {
    final id = pendingLaunchRecognitionId;
    pendingLaunchRecognitionId = null;
    return id;
  }

  @override
  Stream<String> get launchRecognitionIds => _launches.stream;

  @override
  Future<bool> isActiveNetworkMetered() async => isMetered;

  @override
  Future<bool> isNetworkAvailable() async => _isNetworkUp;

  @override
  Stream<bool> get networkAvailability async* {
    yield _isNetworkUp;
    yield* _network.stream;
  }

  @override
  Future<bool> registerEngine(String engineId) async {
    attachedEngineIds.add(engineId);
    return true;
  }

  @override
  Future<bool?> takeOverDeadLock({
    required String path,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) => LocalLockTakeOver(attachedEngineIds: attachedEngineIds).takeOverDeadLock(
    file: File(path),
    expectedContent: expectedContent,
    askingEngineId: askingEngineId,
    ownerEngineId: ownerEngineId,
  );
}
