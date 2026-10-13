import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/device/notification_permission.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/domain/saved_clip_reason.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Saved offline, the `savedOffline` state at `/saved-offline` (P6 design §2.8; wireframe Offline):
/// the clip is on the phone, in the outbox, and will be identified later. Its icon, heading (a
/// status, P6-OFFLINE-25) and text follow [SavedOfflineState.reason] (P6-OFFLINE-22, -24 to -26);
/// "You had 5 clips waiting, so the oldest one was deleted." when a sixth clip made room (P6-D6);
/// a bell panel says whether a notification will bring the result (P6-OFFLINE-27), with "Allow
/// notifications" on Android 13 and later before the listener was asked (T50).
///
/// Close ×, "OK" and system Back go Home, the clip still waiting (T48; P6-OFFLINE-23, -28); "See it
/// in History" goes to the History tab, where it shows as Pending (T49; P6-OFFLINE-29). Where to go
/// is the app's to decide, so both arrive as callbacks.
class SavedOfflineScreen extends StatelessWidget {
  const SavedOfflineScreen({
    super.key,
    required this.state,
    required this.onBackToHome,
    required this.onSeeInHistory,
  });

  final SavedOfflineState state;
  final VoidCallback onBackToHome;
  final VoidCallback onSeeInHistory;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final (icon, iconColour, circleColour, heading, body) = switch (state.reason) {
      SavedClipReason.noConnection => (
        Icons.signal_cellular_off_outlined,
        colours.ink,
        colours.lineSoft,
        words.savedOfflineHeadingNoConnection,
        words.savedOfflineBodyNoConnection,
      ),
      SavedClipReason.busy => (
        Icons.refresh,
        colours.warning,
        colours.warningSoft,
        words.savedOfflineHeadingBusy,
        words.savedOfflineBodyBusy,
      ),
      SavedClipReason.tooManyTries => (
        Icons.schedule,
        colours.warning,
        colours.warningSoft,
        words.savedOfflineHeadingTooManyTries,
        words.savedOfflineBodyTooManyTries,
      ),
    };
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: words.closeButton, onPressed: onBackToHome),
        // "OK" and "See it in History" stay in reach above the bell panel on a 360 × 800 phone.
        isFooterPinned: true,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(icon: icon, iconColour: iconColour, circleColour: circleColour),
            SizedBox(height: spacing.space5),
            StateHeading(heading, role: SemanticsRole.status),
            SizedBox(height: spacing.space2),
            Text(body, style: tokens.typeStyles.body.copyWith(color: colours.muted)),
            if (state.wasOldestClipDeleted) ...[
              SizedBox(height: spacing.space3),
              Text(words.savedOfflineOldestClipDeleted, style: tokens.typeStyles.body),
            ],
            SizedBox(height: spacing.space5),
            const NotificationPanel(),
          ],
        ),
        footer: [
          FilledButton(onPressed: onBackToHome, child: Text(words.okButton)),
          TextButton(onPressed: onSeeInHistory, child: Text(words.savedOfflineSeeInHistoryButton)),
        ],
      ),
    );
  }
}

/// The bell panel (P6 design §2.8): what the notification permission allows, and on Android 13 and
/// later, before the listener was asked, "Allow notifications", which asks the phone (T50); the
/// panel then follows the answer.
class NotificationPanel extends ConsumerStatefulWidget {
  const NotificationPanel({super.key});

  @override
  ConsumerState<NotificationPanel> createState() => _NotificationPanelState();
}

class _NotificationPanelState extends ConsumerState<NotificationPanel> {
  NotificationAccess? _access;
  bool _isAsking = false;

  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  Future<void> _read() async {
    final access = await ref.read(notificationPermissionProvider).readAccess();
    if (mounted) setState(() => _access = access);
  }

  Future<void> _ask() async {
    if (_isAsking) return;
    setState(() => _isAsking = true);
    final access = await ref.read(notificationPermissionProvider).requestAccess();
    if (mounted) {
      setState(() {
        _access = access;
        _isAsking = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final access = _access;
    // Read in a moment; the panel keeps its place meanwhile, so nothing below it moves.
    if (access == null) return const SizedBox(height: 72);
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final (icon, iconColour, text) = switch (access) {
      NotificationAccess.allowed => (
        Icons.notifications_outlined,
        colours.accent,
        words.savedOfflineNotificationsAllowed,
      ),
      NotificationAccess.notAskedYet => (
        Icons.notifications_outlined,
        colours.accent,
        words.savedOfflineNotificationsNotAsked,
      ),
      NotificationAccess.off => (
        Icons.notifications_off_outlined,
        colours.muted,
        words.savedOfflineNotificationsOff,
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colours.surface,
        border: Border.all(color: colours.lineSoft),
        borderRadius: BorderRadius.circular(tokens.radii.large),
      ),
      child: Padding(
        padding: EdgeInsets.all(spacing.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(child: Icon(icon, size: 22, color: iconColour)),
                SizedBox(width: spacing.space3),
                Expanded(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(text, style: tokens.typeStyles.body),
                  ),
                ),
              ],
            ),
            if (access == NotificationAccess.notAskedYet) ...[
              SizedBox(height: spacing.space2),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(
                  onPressed: _isAsking ? null : () => unawaited(_ask()),
                  child: Text(words.savedOfflineAllowNotificationsButton),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
