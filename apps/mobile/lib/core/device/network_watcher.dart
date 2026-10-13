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
  final StreamController<void> _meteredChanged = StreamController<void>.broadcast();
  StreamSubscription<bool>? _subscription;
  bool _isAvailable = true;
  bool _isMetered = false;

  /// Whether a network is up now, as last reported.
  bool get isNetworkAvailable => _isAvailable;

  /// An event each time a network comes back after there was none.
  Stream<void> get networkBack => _networkBack.stream;

  /// Whether the network in use is metered (mobile data, a hotspot), as last read: read at start and
  /// again at each change Android reports (P6 design §3.16). Unmetered until read.
  bool get isMetered => _isMetered;

  /// An event each time [isMetered] changes.
  Stream<void> get meteredChanged => _meteredChanged.stream;

  /// Starts following the network. A second call does nothing.
  void start() {
    if (_subscription != null) return;
    _subscription = _deviceServices.networkAvailability.listen((isAvailable) {
      final wasAvailable = _isAvailable;
      _isAvailable = isAvailable;
      if (isAvailable && !wasAvailable) _networkBack.add(null);
      unawaited(_readMetered());
    });
    unawaited(_readMetered());
  }

  /// Asks Android once whether a network is up now, without waiting for the first report: the
  /// background job decides at once whether to try (P6 design §3.10). A plugin that cannot say
  /// leaves a network assumed.
  Future<void> readNow() async {
    _isAvailable = await _deviceServices.isNetworkAvailable();
    await _readMetered();
  }

  Future<void> _readMetered() async {
    final isMetered = await _deviceServices.isActiveNetworkMetered();
    if (isMetered == _isMetered || _meteredChanged.isClosed) return;
    _isMetered = isMetered;
    _meteredChanged.add(null);
  }

  /// Stops following it.
  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
    await _networkBack.close();
    await _meteredChanged.close();
  }
}
