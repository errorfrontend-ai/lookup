import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/device/network_watcher.dart';

import '../../support/fake_device_services.dart';

/// Whether Android reports a network, and its return (P6 design §3.9 points 1 and 7, §3.15;
/// P6-OFFLINE-07): the outbox tries nothing while there is none, and starts a run when it returns.
void main() {
  late FakeDeviceServices deviceServices;
  late NetworkWatcher watcher;
  late int returns;

  setUp(() {
    deviceServices = FakeDeviceServices();
    watcher = NetworkWatcher(deviceServices: deviceServices);
    returns = 0;
    watcher.networkBack.listen((_) => returns++);
    addTearDown(watcher.dispose);
  });

  test('before the plugin has answered, a network is assumed, so nothing is held back', () {
    expect(watcher.isNetworkAvailable, isTrue);
  });

  test('follows what Android reports, and announces only a return after none', () async {
    deviceServices.setNetwork(isUp: false);
    watcher.start();
    await pumpEventQueue();
    expect(watcher.isNetworkAvailable, isFalse);
    expect(returns, 0);

    deviceServices.setNetwork(isUp: true);
    await pumpEventQueue();
    expect(watcher.isNetworkAvailable, isTrue);
    expect(returns, 1);

    deviceServices.setNetwork(isUp: true);
    await pumpEventQueue();
    expect(returns, 1, reason: 'still up is not a return');

    deviceServices.setNetwork(isUp: false);
    deviceServices.setNetwork(isUp: true);
    await pumpEventQueue();
    expect(returns, 2);
  });

  test('a network already up at start is not a return', () async {
    watcher.start();
    await pumpEventQueue();
    expect(watcher.isNetworkAvailable, isTrue);
    expect(returns, 0);
  });

  test('a second start does not follow twice', () async {
    deviceServices.setNetwork(isUp: false);
    watcher
      ..start()
      ..start();
    await pumpEventQueue();
    deviceServices.setNetwork(isUp: true);
    await pumpEventQueue();
    expect(returns, 1);
  });
}
