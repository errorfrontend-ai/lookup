import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';

/// Home, the `idle` state at `/` (design §2.2; wireframe Main): "Look Up" at the top, and at the
/// bottom, in the thumb zone, the question, how it works, the big "Tap to identify" control and
/// what one identify costs.
///
/// The instruction line is the first-open "how it works" note (gap 44). The wireframe's station
/// chip and bottom navigation belong to Phase 6 and are left out entirely (S4-D1). The tap goes to
/// the flow, which records at once when the microphone is allowed and otherwise shows the
/// Permission screen; a second tap while an identify is under way is ignored there (T41).
///
/// Home has no Back of its own: system Back leaves the app, as on any first screen.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  static const String heading = 'Heard an ad on the radio?';

  static const String instruction =
      'Tap the button and hold your phone near the radio while the ad plays.';

  /// What one identify costs: the clip's length from the clip settings (S4-LISTENING-03), and the
  /// size of the upload it makes (S4-D31).
  static String get dataNote =>
      'About ${RecognitionFlow.clipSettings.clipDurationSeconds} seconds of listening '
      '· about 25 KB of data';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final showsDeveloperTools = ref.watch(appConfigurationProvider).showsDeveloperTools;
    final mutedBody = typeStyles.body.copyWith(color: colours.muted);
    return ScreenFrame(
      title: Row(
        children: [
          Expanded(child: Text('Look Up', style: typeStyles.title)),
          // Flexible, so its words wrap rather than push past the edge at large text sizes.
          if (showsDeveloperTools) const Flexible(child: SendTestErrorButton()),
        ],
      ),
      isBodyAtBottom: true,
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space6,
        spacing.space6,
        spacing.space6,
        spacing.space12,
      ),
      body: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Semantics(
            header: true,
            child: Text(heading, textAlign: TextAlign.center, style: typeStyles.display),
          ),
          SizedBox(height: spacing.space2),
          Text(instruction, textAlign: TextAlign.center, style: mutedBody),
          // 32 dp to the disc; its halo takes 28 of them, as the wireframe draws it.
          SizedBox(height: spacing.space8),
          IdentifyButton(
            onPressed: () => unawaited(ref.read(recognitionFlowProvider.notifier).identify()),
          ),
          SizedBox(height: spacing.space8 + spacing.space3),
          Text(
            dataNote,
            textAlign: TextAlign.center,
            style: typeStyles.caption.copyWith(color: colours.muted),
          ),
        ],
      ),
    );
  }
}
