import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/network/listener_route.dart';

/// Which paths carry the install token (design §3.12; contract §1.0, amendment A3).
void main() {
  const recognitionId = '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70';

  test('the routes are the contract\'s paths', () {
    expect(ListenerRoute.installs, 'installs');
    expect(ListenerRoute.recognize, 'recognize');
    expect(ListenerRoute.stations, 'stations');
    expect(ListenerRoute.engagements, 'engagements');
    expect(ListenerRoute.clientErrors, 'client-errors');
    expect(ListenerRoute.choiceFor(recognitionId), 'recognitions/$recognitionId/choice');
    expect(ListenerRoute.reportFor(recognitionId), 'recognitions/$recognitionId/report');
  });

  test('exactly the listener routes carry the token on every request', () {
    for (final path in [
      ListenerRoute.recognize,
      ListenerRoute.stations,
      ListenerRoute.engagements,
      ListenerRoute.choiceFor(recognitionId),
      ListenerRoute.reportFor(recognitionId),
    ]) {
      expect(ListenerRoute.carriesInstallToken(path), isTrue, reason: path);
      expect(ListenerRoute.mayCarryInstallToken(path), isTrue, reason: path);
    }
  });

  test('installs may carry it, for a re-registration only; it is not a listener route', () {
    expect(ListenerRoute.carriesInstallToken(ListenerRoute.installs), isFalse);
    expect(ListenerRoute.mayCarryInstallToken(ListenerRoute.installs), isTrue);
  });

  test('client-errors and every other path never carry it', () {
    for (final path in [
      ListenerRoute.clientErrors,
      'recognitions',
      'recognitions/$recognitionId',
      'recognitions/$recognitionId/delete',
      'recognitions/$recognitionId/choice/again',
      'recognitions/${recognitionId.toUpperCase()}/choice',
      'recognitions/not-a-uuid/choice',
      'recognitions/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f7/choice',
      'stations/0192a6c4-1111-4000-8000-000000000001',
      'recognize/',
      'engagement',
      '',
    ]) {
      expect(ListenerRoute.carriesInstallToken(path), isFalse, reason: path);
      expect(ListenerRoute.mayCarryInstallToken(path), isFalse, reason: path);
    }
  });
}
