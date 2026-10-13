import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/device/notification_permission.dart';
import 'package:lookup_listener/core/theme/look_up_theme.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';
import 'package:lookup_listener/features/identify/presentation/saved_offline_screen.dart';

import '../../../support/fake_notification_permission.dart';
import 'identify_screen_harness.dart';

const SavedOfflineState _noConnection = SavedOfflineState(
  reason: SavedClipReason.noConnection,
  wasOldestClipDeleted: false,
);

/// Saved offline (P6 design §2.8; wireframe Offline; P6-OFFLINE-22 to -29; T48 to T50).
void main() {
  late List<String> calls;

  setUp(() => calls = []);

  Future<IdentifyScreenHarness> show(
    WidgetTester tester, {
    SavedOfflineState state = _noConnection,
    NotificationAccess access = NotificationAccess.allowed,
    NotificationAccess accessAfterRequest = NotificationAccess.allowed,
    ThemeData? theme,
  }) async {
    final harness = IdentifyScreenHarness(
      state: state,
      notificationPermission: FakeNotificationPermission(
        access: access,
        accessAfterRequest: accessAfterRequest,
      ),
    );
    await harness.pump(
      tester,
      SavedOfflineScreen(
        state: state,
        onBackToHome: () => calls.add('backToHome'),
        onSeeInHistory: () => calls.add('seeInHistory'),
      ),
      theme: theme,
    );
    await tester.pump();
    return harness;
  }

  group('the words follow why the clip was kept (P6-OFFLINE-22, -24 to -26)', () {
    const colours = LookUpColours.light;
    for (final (reason, heading, body, icon, iconColour, circleColour) in [
      (
        SavedClipReason.noConnection,
        "Saved — we'll identify it when you're back online",
        'No signal right now. Your clip stays on this phone for up to 24 hours and is deleted as '
            "soon as it's sent.",
        Icons.signal_cellular_off_outlined,
        colours.ink,
        colours.lineSoft,
      ),
      (
        SavedClipReason.busy,
        "Saved — we'll identify it when Look Up is less busy",
        'Lots of people are listening right now. Your clip stays on this phone for up to 24 hours '
            "and is deleted as soon as it's sent.",
        Icons.refresh,
        colours.warning,
        colours.warningSoft,
      ),
      (
        SavedClipReason.tooManyTries,
        "Saved — we'll identify it a little later",
        "You've identified a lot in a short time. Your clip stays on this phone for up to 24 hours "
            "and is deleted as soon as it's sent.",
        Icons.schedule,
        colours.warning,
        colours.warningSoft,
      ),
    ]) {
      testWidgets('${reason.name}: "$heading", announced as a status', (tester) async {
        final semantics = tester.ensureSemantics();
        await show(tester, state: SavedOfflineState(reason: reason, wasOldestClipDeleted: false));
        expect(find.text(body), findsOneWidget);
        expectStateHeading(tester, heading, SemanticsRole.status);
        expectStateIcon(tester, icon: icon, iconColour: iconColour, circleColour: circleColour);
        expect(find.text('You had 5 clips waiting, so the oldest one was deleted.'), findsNothing);
        semantics.dispose();
      });
    }

    testWidgets('a sixth clip says the oldest was deleted (P6-D6)', (tester) async {
      await show(
        tester,
        state: const SavedOfflineState(
          reason: SavedClipReason.noConnection,
          wasOldestClipDeleted: true,
        ),
      );
      expect(find.text('You had 5 clips waiting, so the oldest one was deleted.'), findsOneWidget);
    });
  });

  group('the bell panel says whether a notification will bring the result (P6-OFFLINE-27)', () {
    testWidgets('allowed', (tester) async {
      await show(tester);
      expect(
        find.text("You'll get a notification with the result, including the station's buttons."),
        findsOneWidget,
      );
      expect(find.text('Allow notifications'), findsNothing);
    });

    testWidgets('off: the result waits in History', (tester) async {
      await show(tester, access: NotificationAccess.off);
      expect(
        find.text('Notifications are off for Look Up, so the result will wait in History.'),
        findsOneWidget,
      );
      expect(find.text('Allow notifications'), findsNothing);
    });

    testWidgets('not asked yet: "Allow notifications" asks the phone, once, and the panel follows '
        'the answer (T50)', (tester) async {
      final harness = await show(tester, access: NotificationAccess.notAskedYet);
      expect(find.text('Allow notifications to hear when the result is ready.'), findsOneWidget);

      await scrollToAndTap(tester, find.text('Allow notifications'));
      await tester.pump();
      expect(harness.notificationPermission.requestCount, 1);
      expect(
        find.text("You'll get a notification with the result, including the station's buttons."),
        findsOneWidget,
      );
      expect(find.text('Allow notifications'), findsNothing);
    });

    testWidgets('refused in the dialog: off', (tester) async {
      await show(
        tester,
        access: NotificationAccess.notAskedYet,
        accessAfterRequest: NotificationAccess.off,
      );
      await scrollToAndTap(tester, find.text('Allow notifications'));
      await tester.pump();
      expect(
        find.text('Notifications are off for Look Up, so the result will wait in History.'),
        findsOneWidget,
      );
    });

    testWidgets('the panel\'s words are a live region, so a change is announced', (tester) async {
      final semantics = tester.ensureSemantics();
      await show(tester);
      final panelText = tester.getSemantics(
        find.text("You'll get a notification with the result, including the station's buttons."),
      );
      expect(panelText.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      semantics.dispose();
    });
  });

  group('each control (T48, T49; P6-OFFLINE-23, -28, -29)', () {
    testWidgets('"OK", Close and system Back go Home, the clip still waiting', (tester) async {
      final semantics = tester.ensureSemantics();
      final harness = await show(tester);
      expect(find.bySemanticsLabel('Close'), findsOneWidget, reason: 'the × is read as "Close"');
      semantics.dispose();
      await tester.tap(find.text('OK'));
      await tester.tap(find.byType(ScreenExitButton));
      expect(calls, ['backToHome', 'backToHome']);
      await pressSystemBack(tester);
      expect(harness.flow.calls, ['backToHome'], reason: 'system Back asks the flow, as on Error');
    });

    testWidgets('"See it in History" goes to the History tab', (tester) async {
      await show(tester);
      await tester.tap(find.text('See it in History'));
      expect(calls, ['seeInHistory']);
    });

    testWidgets('"OK" and "See it in History" are in reach with no scrolling on a 360 × 800 phone, '
        'whatever the panel says', (tester) async {
      for (final access in NotificationAccess.values) {
        await show(
          tester,
          state: const SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: true),
          access: access,
        );
        for (final control in ['OK', 'See it in History']) {
          expect(tester.getRect(find.text(control)).bottom, lessThanOrEqualTo(800));
        }
      }
    });
  });

  group('fits and reads well everywhere', () {
    for (final (name, theme) in [('light', LookUpTheme.light()), ('dark', LookUpTheme.dark())]) {
      testWidgets('meets the tap target, label and contrast guidelines in the $name theme', (
        tester,
      ) async {
        await show(tester, access: NotificationAccess.notAskedYet, theme: theme);
        await expectMeetsTapGuidelines(tester);
      });
    }

    testWidgets('fits every phone with no overflow and no clipped text', (tester) async {
      const state = SavedOfflineState(reason: SavedClipReason.busy, wasOldestClipDeleted: true);
      await IdentifyScreenHarness(
        state: state,
        notificationPermission: FakeNotificationPermission(access: NotificationAccess.notAskedYet),
      ).expectFitsEveryPhone(
        tester,
        SavedOfflineScreen(state: state, onBackToHome: () {}, onSeeInHistory: () {}),
      );
    });
  });
}
