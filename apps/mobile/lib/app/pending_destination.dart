import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_route.dart';

/// Where the app lands when the identify under way ends (P6 design §3.7, P6-D14): a flow screen
/// that ends somewhere other than Home — "See it in History" on Saved offline, Cancel on a chooser
/// opened from History, a notification's tap (piece 3) — sets it before the recognition flow
/// returns to idle, so the router's redirect goes there in one step, with no frame of Home.
///
/// The redirect takes it once ([take]); it waits while an identify is under way, so a notification
/// tapped during one never interrupts it. Only a place the app may show while idle can be kept: a
/// tab, a page opened from Settings, or a saved result.
final class PendingDestination extends ValueNotifier<String?> {
  PendingDestination() : super(null);

  /// Keeps [location] for the next time the flow returns to idle, replacing any other. Throws an
  /// [ArgumentError] for a flow screen or a path the app does not know: not a place the app shows
  /// while idle.
  void keep(String location) {
    final route = AppRoute.forLocation(location);
    if (route == null || route.isFlowRoute) throw ArgumentError.value(location);
    value = location;
  }

  /// The kept location, which is forgotten as it is given; null when there is none.
  String? take() {
    final location = value;
    value = null;
    return location;
  }
}

/// The app's one pending destination, read by the router.
final Provider<PendingDestination> pendingDestinationProvider = Provider<PendingDestination>((ref) {
  final pendingDestination = PendingDestination();
  ref.onDispose(pendingDestination.dispose);
  return pendingDestination;
}, retry: (retryCount, error) => null);
