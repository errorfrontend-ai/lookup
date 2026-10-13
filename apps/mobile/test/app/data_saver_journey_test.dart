import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/features/result/presentation/banner_box.dart';
import 'package:lookup_listener/features/settings/data/picture_setting_store.dart';

import '../features/result/support/fake_image_http_client.dart';
import '../support/english_words.dart';
import 'listener_app_harness.dart';

/// "Load ad pictures on mobile data" through the whole app (P6 design §3.16; P6-DATASAVER-05, -06):
/// the network as the device plugin reports it, the switch as Settings keeps it, and every picture
/// request the result would make, recorded by a fake image client.
void main() {
  for (final (network, isMetered, isSwitchOn, loadsPictures) in [
    ('mobile data, the switch off', true, false, false),
    ('Wi-Fi, the switch off', false, false, true),
    ('mobile data, the switch on', true, true, true),
  ]) {
    testWidgets(
      '$network: ${loadsPictures ? 'the banner and logo are requested' : 'no picture is '
                'requested and no banner box drawn'}; Call still opens the dialler',
      (tester) async {
        final images = FakeImageHttpClient(imageBytes: await encodeTestImage(tester));
        await withFakeImageServer(images, () async {
          final harness = ListenerAppHarness(
            storedPreferences: {PictureSettingStore.loadsPicturesOnMobileDataKey: isSwitchOn},
          );
          harness.deviceServices.isMetered = isMetered;
          harness.answerWithResponseFixture('valid/match-with-images');
          await harness.pumpApp(tester);
          // What bootstrap() starts: the watcher reads whether the network is metered.
          harness.container(tester).read(networkWatcherProvider).start();
          await tester.pump();

          await tester.tap(find.text(englishWords.identifyButtonLabel));
          await harness.pumpTransition(tester);
          await harness.recordWholeClip(tester);
          await harness.pumpTransition(tester);
          expect(harness.location(tester), '/result');
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
          await tester.pump();

          expect(find.byType(BannerBox), loadsPictures ? findsOneWidget : findsNothing);
          expect(images.requestedAddresses.isNotEmpty, loadsPictures);

          await tester.ensureVisible(find.text('Call us'));
          await tester.tap(find.text('Call us'));
          await tester.pump();
          expect(harness.launcher.openedAddresses.single, startsWith('tel:'));
        });
      },
    );
  }
}
