import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../support/repository_file_locator.dart';

/// One call to `launchUrl`, as the launcher made it.
final class _OpenCall {
  const _OpenCall(this.address, this.mode);

  final Uri address;
  final LaunchMode mode;
}

void main() {
  group('UrlLauncherActionLauncher (design §3.14, S4-LINKS-10 and -11)', () {
    late List<_OpenCall> openCalls;

    UrlLauncherActionLauncher launcherAnswering(Future<bool> Function() answer) {
      return UrlLauncherActionLauncher(
        openUrl: (address, {mode = LaunchMode.platformDefault}) {
          openCalls.add(_OpenCall(address, mode));
          return answer();
        },
      );
    }

    setUp(() => openCalls = []);

    for (final address in [
      'tel:+260977123456',
      'https://wa.me/260966123456?text=Hi%2C%20I%20heard%20your%20ad',
      'https://www.google.com/maps/dir/?api=1&destination=-15.416700%2C28.283300',
      'https://example.co.zm/menu?utm_source=lookup',
    ]) {
      test('opens $address unchanged, in an external application', () async {
        final launcher = launcherAnswering(() async => true);

        expect(await launcher.open(address), isTrue);

        expect(openCalls, hasLength(1));
        expect(openCalls.single.address.toString(), address);
        expect(openCalls.single.mode, LaunchMode.externalApplication);
      });
    }

    test('"false" from the platform means the phone could not open it', () async {
      final launcher = launcherAnswering(() async => false);
      expect(await launcher.open('tel:+260977123456'), isFalse);
    });

    test('a PlatformException means the phone could not open it, and is not thrown', () async {
      final launcher = launcherAnswering(
        () => Future<bool>.error(PlatformException(code: 'ACTIVITY_NOT_FOUND')),
      );
      expect(await launcher.open('tel:+260977123456'), isFalse);
    });

    test('a missing plugin means the phone could not open it', () async {
      final launcher = launcherAnswering(
        () => Future<bool>.error(MissingPluginException('No implementation found')),
      );
      expect(await launcher.open('https://example.co.zm/'), isFalse);
    });

    test('an address that does not parse is not opened at all', () async {
      final launcher = launcherAnswering(() async => true);
      expect(await launcher.open('https://['), isFalse);
      expect(openCalls, isEmpty);
    });

    test('a programming error is not hidden: it reaches the global handler', () async {
      final launcher = launcherAnswering(() => Future<bool>.error(StateError('a bug')));
      await expectLater(launcher.open('tel:+260977123456'), throwsStateError);
    });

    test('never asks the platform beforehand whether it can open an address', () {
      final source = RepositoryFileLocator.mobileAppFile(
        'lib/features/result/data/action_launcher.dart',
      ).readAsStringSync();
      expect(source, isNot(contains('canLaunch')));
      expect(source, contains('LaunchMode.externalApplication'));
    });
  });

  test('the provider gives the url_launcher launcher, and tests can replace it', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    expect(container.read(actionLauncherProvider), isA<UrlLauncherActionLauncher>());

    final replacement = UrlLauncherActionLauncher(
      openUrl: (address, {mode = LaunchMode.platformDefault}) async => false,
    );
    final overridden = ProviderContainer(
      overrides: [actionLauncherProvider.overrideWithValue(replacement)],
    );
    addTearDown(overridden.dispose);
    expect(overridden.read(actionLauncherProvider), same(replacement));
  });
}
