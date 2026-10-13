import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/device/notification_permission.dart';

import '../../support/fake_device_services.dart';

/// `permission_handler`'s channel, as its Android side answers it.
const MethodChannel _permissionChannel = MethodChannel('flutter.baseflow.com/permissions/methods');

/// `Permission.notification` on that channel.
const int _notificationPermission = 17;

/// What the Saved screen's bell panel reads, and "Allow notifications" (P6 design §2.8, §3.15; Q4;
/// T50): the plugin's "are they on for this app" first, the system permission only when they are
/// not, and never a throw.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeDeviceServices deviceServices;
  late List<MethodCall> permissionCalls;

  /// The system permission's answers: its status, and what a request leaves it at.
  void answerPermission({required int status, int? afterRequest, bool fails = false}) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _permissionChannel,
      (call) async {
        permissionCalls.add(call);
        if (fails) throw PlatformException(code: 'broken');
        return switch (call.method) {
          'checkPermissionStatus' => status,
          'requestPermissions' => {_notificationPermission: afterRequest ?? status},
          _ => null,
        };
      },
    );
  }

  setUp(() {
    deviceServices = FakeDeviceServices();
    permissionCalls = [];
    answerPermission(status: 0);
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_permissionChannel, null),
  );

  NotificationPermission permission({bool isIos = false}) =>
      NotificationPermission(deviceServices: deviceServices, isIos: isIos);

  group('readAccess', () {
    test('on for this app: allowed, with no look at the system permission', () async {
      expect(await permission().readAccess(), NotificationAccess.allowed);
      expect(permissionCalls, isEmpty);
    });

    test('off, never asked (Android 13 and later): "Allow notifications" is offered', () async {
      deviceServices.areNotificationsOn = false;
      answerPermission(status: 0);
      expect(await permission().readAccess(), NotificationAccess.notAskedYet);
      expect(permissionCalls.single.arguments, _notificationPermission);
    });

    for (final (name, status) in [('refused for good', 4), ('restricted', 2)]) {
      test('off, $name: off, with nothing to ask', () async {
        deviceServices.areNotificationsOn = false;
        answerPermission(status: status);
        expect(await permission().readAccess(), NotificationAccess.off);
      });
    }

    test('a permission check that fails reads as off', () async {
      deviceServices.areNotificationsOn = false;
      answerPermission(status: 0, fails: true);
      expect(await permission().readAccess(), NotificationAccess.off);
    });

    test('iOS: off, with no call at all (no notifications in this version)', () async {
      expect(await permission(isIos: true).readAccess(), NotificationAccess.off);
      expect(permissionCalls, isEmpty);
    });
  });

  group('requestAccess', () {
    test('asks the system, then reads whether they are on for this app', () async {
      deviceServices.areNotificationsOn = false;
      answerPermission(status: 0, afterRequest: 1);
      final pending = permission().requestAccess();
      deviceServices.areNotificationsOn = true;
      expect(await pending, NotificationAccess.allowed);
      expect(permissionCalls.single.method, 'requestPermissions');
      expect(permissionCalls.single.arguments, [_notificationPermission]);
    });

    test('refused in the dialog: off', () async {
      deviceServices.areNotificationsOn = false;
      answerPermission(status: 0, afterRequest: 0);
      expect(await permission().requestAccess(), NotificationAccess.off);
    });

    test('a request that fails reads as off', () async {
      deviceServices.areNotificationsOn = false;
      answerPermission(status: 0, fails: true);
      expect(await permission().requestAccess(), NotificationAccess.off);
    });

    test('iOS: off, and nothing is asked', () async {
      expect(await permission(isIos: true).requestAccess(), NotificationAccess.off);
      expect(permissionCalls, isEmpty);
    });
  });
}
