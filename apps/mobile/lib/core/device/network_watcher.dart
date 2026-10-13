import 'dart:async';

import 'package:device_services/device_services.dart';

/// Whether Android reports a network, and when one comes back (P6 design §3.9 points 1 and 7, §3.15):
/// the outbox tries no send while there is none, and starts a run when one returns while the app is
/// open.
///
/// Until the plugin has answered, a network is assumed, so nothing is held back for a platform that
/// cannot say (iOS, where the plugin reports "not supported").
class NetworkWatcher {
  NetworkWatcher({required DeviceServices deviceServices}) : _deviceServices = deviceServices;

  final DeviceServices _deviceServices;
  final StreamController<void> _networkBack = StreamController<void>.broadcast();
  StreamSubscription<bool>? _subscription;
  bool _isAvailable = true;

  /// Whether a network is up now, as last reported.
  bool get isNetworkAvailable => _isAvailable;

  /// An event each time a network comes back after there was none.
  Stream<void> get networkBack => _networkBack.stream;

  /// Starts following the network. A second call does nothing.
  void start() {
    if (_subscription != null) return;
    _subscription = _deviceServices.networkAvailability.listen((isAvailable) {
      final wasAvailable = _isAvailable;
      _isAvailable = isAvailable;
      if (isAvailable && !wasAvailable) _networkBack.add(null);
    });
  }

  /// Asks Android once whether a network is up now, without waiting for the first report: the
  /// background job decides at once whether to try (P6 design §3.10). A plugin that cannot say
  /// leaves a network assumed.
  Future<void> readNow() async {
    _isAvailable = await _deviceServices.isNetworkAvailable();
  }

  /// Stops following it.
  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
    await _networkBack.close();
  }
}
