import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Permission, the `permissionNeeded` state at `/permission` (design §2.3; wireframe Permission):
/// why Look Up needs the microphone, shown only after an Identify tap while it is not allowed. The
/// system prompt appears only after "Allow microphone" (S4-PERMISSION-02).
///
/// Three variants (S4-D22, gap 31), from [microphoneAccess]: as drawn when the app has never asked;
/// a sentence saying the listener refused, when they did once; and, when the system will not ask
/// again, a sentence pointing to the phone's settings with "Open phone settings" as the main
/// button. The wireframe's offline promise is left out: there is no offline capture before Phase 6,
/// so it would be false (S4-D1).
class PermissionScreen extends ConsumerWidget {
  const PermissionScreen({super.key, required this.microphoneAccess});

  /// Which variant: never `MicrophoneAccess.granted`, which records instead.
  final MicrophoneAccess microphoneAccess;

  /// The promises, each after a tick.
  static List<String> promisesOf(AppLocalizations words) => [
    words.permissionPromiseOnlyWhenYouTap,
    words.permissionPromiseNeverWhoYouAre,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final flow = ref.read(recognitionFlowProvider.notifier);
    final words = AppLocalizations.of(context);
    final isRefusedForGood = microphoneAccess == MicrophoneAccess.refusedForGood;
    final variantNote = switch (microphoneAccess) {
      MicrophoneAccess.notAskedYet || MicrophoneAccess.granted => null,
      MicrophoneAccess.refusedOnce => words.permissionRefusedOnceNote,
      MicrophoneAccess.refusedForGood => words.permissionRefusedForGoodNote,
    };
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.back(label: words.backButton, onPressed: flow.backToHome),
        bodyPadding: EdgeInsets.fromLTRB(spacing.space6, spacing.space4, spacing.space6, 0),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(
              icon: Icons.mic_none,
              iconColour: colours.accent,
              circleColour: colours.accentSoft,
            ),
            SizedBox(height: spacing.space5),
            Semantics(
              header: true,
              child: Text(words.permissionHeading, style: typeStyles.headline),
            ),
            SizedBox(height: spacing.space5),
            Text(
              words.permissionExplanation,
              style: typeStyles.body.copyWith(color: colours.muted),
            ),
            SizedBox(height: spacing.space5),
            for (final (index, promise) in promisesOf(words).indexed) ...[
              if (index > 0) SizedBox(height: spacing.space3),
              _Promise(text: promise),
            ],
            if (variantNote != null) ...[
              SizedBox(height: spacing.space5),
              // Announced, because it appears after the system prompt closes, with no tap on it.
              Semantics(liveRegion: true, child: Text(variantNote, style: typeStyles.body)),
            ],
          ],
        ),
        footer: [
          FilledButton(
            onPressed: isRefusedForGood
                ? () => unawaited(flow.openPhoneSettings())
                : () => unawaited(flow.allowMicrophone()),
            child: Text(
              isRefusedForGood ? words.openPhoneSettingsButton : words.allowMicrophoneButton,
            ),
          ),
          TextButton(onPressed: flow.backToHome, child: Text(words.notNowButton)),
          // Hidden when refused for good: the main button already opens the settings.
          if (!isRefusedForGood) _SettingsLine(onOpen: () => unawaited(flow.openPhoneSettings())),
        ],
      ),
    );
  }
}

/// One promise after a green tick; the tick is decoration, so only the words are read.
class _Promise extends StatelessWidget {
  const _Promise({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: Icon(Icons.check, size: spacing.space5, color: tokens.colours.success),
        ),
        SizedBox(width: spacing.space3),
        Expanded(child: Text(text, style: tokens.typeStyles.body)),
      ],
    );
  }
}

/// "Said no before? Open phone settings", under the buttons; it wraps onto two lines when the
/// text is large.
class _SettingsLine extends StatelessWidget {
  const _SettingsLine({required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final caption = tokens.typeStyles.caption;
    final words = AppLocalizations.of(context);
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(words.permissionSaidNoBefore, style: caption.copyWith(color: tokens.colours.muted)),
        TextButton(
          onPressed: onOpen,
          style: TextButton.styleFrom(textStyle: caption.copyWith(fontWeight: FontWeight.w600)),
          child: Text(words.openPhoneSettingsButton),
        ),
      ],
    );
  }
}
