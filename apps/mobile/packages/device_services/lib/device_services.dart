import 'dart:async';

import 'package:flutter/services.dart';

/// Look Up's own platform services (P6 design §3.15), from the in-repo `device_services` plugin:
/// Android only in Phase 6; on iOS (and wherever the plugin is missing) every call answers as "not
/// supported": no notifications, a network assumed, nothing metered, and only this engine attached.
///
/// Every method answers and never throws: a platform failure gives the same safe answer as "not
/// supported", so a broken plugin can never stop an identify. Tests implement this class with a fake
/// (`FakeDeviceServices`), so nothing here is ever reached in a unit test.
class DeviceServices {
  const DeviceServices();

  /// The extra a result notification's intent carries: the recognition id it opens.
  static const String recognitionIdExtra = 'zm.lookup.recognition_id';

  static const MethodChannel _methods = MethodChannel('zm.lookup.device_services/methods');
  static const EventChannel _networkEvents = EventChannel('zm.lookup.device_services/network');
  static const EventChannel _launchEvents = EventChannel('zm.lookup.device_services/launches');

  /// Whether the app may post notifications now (`NotificationManager.areNotificationsEnabled`).
  Future<bool> areNotificationsEnabled() => _call<bool>('areNotificationsEnabled', fallback: false);

  /// Posts (or updates, for the same [notificationId]) a saved clip's notification, on the channel
  /// [channelName] described as [channelDescription]. Its tap opens the app with [recognitionId] as
  /// the launch extra. The words are the app's own, generic ones (A6); nothing here adds others.
  Future<void> showSavedClipNotification({
    required int notificationId,
    required String title,
    required String text,
    required String recognitionId,
    required String channelName,
    required String channelDescription,
  }) async {
    await _call<Object?>(
      'showSavedClipNotification',
      arguments: {
        'notification_id': notificationId,
        'title': title,
        'text': text,
        'recognition_id': recognitionId,
        'channel_name': channelName,
        'channel_description': channelDescription,
      },
      fallback: null,
    );
  }

  /// The recognition id the activity was started with by a notification's tap, once; null when
  /// there was none, or it was already taken.
  Future<String?> takeLaunchRecognitionId() =>
      _call<String?>('takeLaunchRecognitionId', fallback: null);

  /// Recognition ids from notification taps that arrive while the app runs.
  Stream<String> get launchRecognitionIds => _launchEvents
      .receiveBroadcastStream()
      .where((value) => value is String)
      .cast<String>()
      .handleError(
        (Object error) {},
        test: (error) => error is PlatformException || error is MissingPluginException,
      );

  /// Whether the active network is metered (mobile data, a hotspot): the data saver's question.
  Future<bool> isActiveNetworkMetered() => _call<bool>('isActiveNetworkMetered', fallback: false);

  /// Whether Android reports any network that can reach the internet now.
  Future<bool> isNetworkAvailable() => _call<bool>('isNetworkAvailable', fallback: true);

  /// The network's availability: the current state first, then each change.
  Stream<bool> get networkAvailability => _networkEvents
      .receiveBroadcastStream()
      .where((value) => value is bool)
      .cast<bool>()
      .handleError(
        (Object error) {},
        test: (error) => error is PlatformException || error is MissingPluginException,
      );

  /// Records [engineId] as an attached engine of this process, until its engine is destroyed.
  /// Answers whether the plugin keeps such a record (false on a platform without it).
  Future<bool> registerEngine(String engineId) =>
      _call<bool>('registerEngine', arguments: {'engine_id': engineId}, fallback: false);

  /// For the whole process at once: removes the lock file at [path] when it still holds exactly
  /// [expectedContent] and its owner is gone, and answers whether it did. The owner is gone when
  /// [ownerEngineId] is not an attached engine of this process; when the lock names no owner
  /// ([ownerEngineId] null, left by a crash mid-write), only when no engine but [askingEngineId] is
  /// attached. Null on a platform without the record, where the caller decides alone.
  Future<bool?> takeOverDeadLock({
    required String path,
    required String expectedContent,
    required String askingEngineId,
    required String? ownerEngineId,
  }) => _call<bool?>(
    'takeOverDeadLock',
    arguments: {
      'path': path,
      'expected_content': expectedContent,
      'asking_engine_id': askingEngineId,
      'owner_engine_id': ownerEngineId,
    },
    fallback: null,
  );

  static Future<T> _call<T>(
    String method, {
    Map<String, Object?>? arguments,
    required T fallback,
  }) async {
    try {
      final result = await _methods.invokeMethod<Object?>(method, arguments);
      return result is T ? result : fallback;
    } on PlatformException {
      return fallback;
    } on MissingPluginException {
      return fallback;
    }
  }
}
