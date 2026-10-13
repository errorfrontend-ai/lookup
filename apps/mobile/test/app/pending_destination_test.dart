import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/pending_destination.dart';

/// Where the app lands when an identify ends (P6 design §3.7, P6-D14).
void main() {
  test('holds nothing at first', () {
    expect(PendingDestination().take(), isNull);
  });

  test('a kept place is given once, then forgotten', () {
    final destination = PendingDestination()..keep(AppRoute.history.path);
    expect(destination.take(), '/history');
    expect(destination.take(), isNull);
  });

  test('a later place replaces an earlier one', () {
    final destination = PendingDestination()
      ..keep(AppRoute.history.path)
      ..keep(AppRoute.savedResultLocation('0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70'));
    expect(destination.take(), '/r/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70');
  });

  test('keeps only places the app shows while idle: tabs, Settings pages, saved results', () {
    final destination = PendingDestination();
    for (final route in AppRoute.values.where((route) => !route.isFlowRoute)) {
      final location = route == AppRoute.savedResult
          ? AppRoute.savedResultLocation('0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70')
          : route.path;
      destination.keep(location);
      expect(destination.take(), location, reason: route.name);
    }
  });

  test('refuses a flow screen or a path the app does not know', () {
    final destination = PendingDestination();
    for (final location in [...AppRoute.flowRoutes.map((route) => route.path), '/ads', '/r/']) {
      expect(() => destination.keep(location), throwsArgumentError, reason: location);
    }
    expect(destination.take(), isNull);
  });
}
