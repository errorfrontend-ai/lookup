import 'dart:io' show Platform;

import 'package:device_services/device_services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

/// Whether the app may tell the listener a saved clip's result (P6 design §2.8, §3.15; Q4): what the
/// Saved screen's bell panel says.
enum NotificationAccess {
  /// Notifications are on (Android below 13 with them on, or 13 and later granted).
  allowed,

  /// Android 13 or later, and the app has not been allowed yet: the panel offers "Allow
  /// notifications".
  notAskedYet,

  /// Refused, turned off for the app, or iOS (no notifications in this version).
  off,
}

/// Reads and asks for the notification permission (T50): `permission_handler`'s
/// `Permission.notification`, and the `device_services` plugin's "are they on for this app". Asked
/// only from "Allow notifications", never by itself (Q4). Never throws: a failure reads as [off].
class NotificationPermission {
  NotificationPermission({required DeviceServices deviceServices, bool? isIos})
    : _deviceServices = deviceServices,
      _isIos = isIos ?? Platform.isIOS;

  final DeviceServices _deviceServices;
  final bool _isIos;

  /// What the panel says now.
  Future<NotificationAccess> readAccess() async {
    if (_isIos) return NotificationAccess.off;
    try {
      if (await _deviceServices.areNotificationsEnabled()) return NotificationAccess.allowed;
      final status = await Permission.notification.status;
      return status.isPermanentlyDenied || status.isRestricted
          ? NotificationAccess.off
          : NotificationAccess.notAskedYet;
    } on Object {
      return NotificationAccess.off;
    }
  }

  /// Asks the phone (the system dialog on Android 13 and later), then answers what the panel says
  /// after the listener's choice.
  Future<NotificationAccess> requestAccess() async {
    if (_isIos) return NotificationAccess.off;
    try {
      await Permission.notification.request();
      return await _deviceServices.areNotificationsEnabled()
          ? NotificationAccess.allowed
          : NotificationAccess.off;
    } on Object {
      return NotificationAccess.off;
    }
  }
}

/// The notification permission. Made at start-up from the app's `device_services`, which `lib/app`
/// provides, so `bootstrap()` gives it through `appServiceOverrides`; tests override it with a fake.
final Provider<NotificationPermission> notificationPermissionProvider =
    Provider<NotificationPermission>(
      (ref) => throw UnimplementedError(
        'Override notificationPermissionProvider at start-up with the app NotificationPermission.',
      ),
      retry: (retryCount, error) => null,
    );
