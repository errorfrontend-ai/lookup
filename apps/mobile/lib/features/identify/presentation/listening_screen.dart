import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';

/// Listening, the `recording` state at `/listening` (design §2.4; wireframe Listening): the ring and
/// the level bars follow the live level, and a bar and "[n] seconds left" count the clip down. After
/// the clip's 8 seconds the flow moves on by itself (T11).
///
/// Close ×, "Cancel" and system Back all stop the recorder, delete the partial clip and send
/// nothing (T12); leaving the app does the same, in the flow (T13).
class ListeningScreen extends ConsumerWidget {
  const ListeningScreen({super.key, required this.levelFraction, required this.secondsLeft});

  /// The live input level, 0 to 1.
  final double levelFraction;

  /// The countdown, from the clip's length in seconds to 0.
  final int secondsLeft;

  static const String heading = 'Listening…';

  static const String instruction = 'Keep your phone near the radio';

  /// "8 seconds left", "1 second left", "0 seconds left".
  static String countdownText(int secondsLeft) =>
      secondsLeft == 1 ? '1 second left' : '$secondsLeft seconds left';

  /// How much of the clip is recorded: 0.625 with 3 of 8 seconds left.
  static double recordedFraction(int secondsLeft) {
    final clipSeconds = RecognitionFlow.clipSettings.clipDurationSeconds;
    return ((clipSeconds - secondsLeft) / clipSeconds).clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final flow = ref.read(recognitionFlowProvider.notifier);
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: 'Cancel listening', onPressed: flow.backToHome),
        // Centred in the space between the header and the footer, as the wireframe draws it.
        body: Expanded(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LevelRing(levelFraction: levelFraction),
                // The ring's box already holds its 60 dp halo: 4 dp more makes the wireframe's gap.
                SizedBox(height: spacing.space1),
                const StateHeading(
                  heading,
                  role: SemanticsRole.status,
                  textAlign: TextAlign.center,
                ),
                SizedBox(height: spacing.space2),
                Text(
                  instruction,
                  textAlign: TextAlign.center,
                  style: typeStyles.body.copyWith(color: colours.muted),
                ),
                SizedBox(height: spacing.space6),
                LevelBars(levelFraction: levelFraction),
                SizedBox(height: spacing.space6),
                ConstrainedBox(
                  // 220 dp, or less on a narrower screen.
                  constraints: BoxConstraints(maxWidth: spacing.space10 * 5 + spacing.space5),
                  child: ProgressTrack(
                    fraction: recordedFraction(secondsLeft),
                    fillColour: colours.accent,
                  ),
                ),
                SizedBox(height: spacing.space2),
                Text(
                  countdownText(secondsLeft),
                  textAlign: TextAlign.center,
                  style: typeStyles.caption.copyWith(
                    color: colours.muted,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
        footer: [OutlinedButton(onPressed: flow.backToHome, child: const Text('Cancel'))],
      ),
    );
  }
}
