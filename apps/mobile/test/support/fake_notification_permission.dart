import 'package:lookup_listener/core/device/notification_permission.dart';

/// The notification permission in tests: [access] is what the panel reads; "Allow notifications"
/// answers [accessAfterRequest] and counts the requests.
class FakeNotificationPermission implements NotificationPermission {
  FakeNotificationPermission({
    this.access = NotificationAccess.allowed,
    this.accessAfterRequest = NotificationAccess.allowed,
  });

  NotificationAccess access;
  NotificationAccess accessAfterRequest;
  int requestCount = 0;

  @override
  Future<NotificationAccess> readAccess() async => access;

  @override
  Future<NotificationAccess> requestAccess() async {
    requestCount++;
    access = accessAfterRequest;
    return access;
  }
}
