import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/listening_layout.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

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

  /// How much of the clip is recorded: 0.625 with 3 of 8 seconds left.
  static double recordedFraction(int secondsLeft) {
    final clipSeconds = RecognitionFlow.clipSettings.clipDurationSeconds;
    return ((clipSeconds - secondsLeft) / clipSeconds).clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colours = context.lookUpTokens.colours;
    final flow = ref.read(recognitionFlowProvider.notifier);
    final words = AppLocalizations.of(context);
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(
          label: words.cancelListeningLabel,
          onPressed: flow.backToHome,
        ),
        // Centred in the space between the header and the footer, as the wireframe draws it, and
        // shared with Identifying so the ring stays put when the clip is sent.
        body: Expanded(
          child: ListeningLayout(
            ring: LevelRing(levelFraction: levelFraction),
            heading: words.listeningHeading,
            headingToFit: words.identifyingHeading,
            text: words.listeningInstruction,
            textToFit: words.identifyingExplanation,
            levelBars: LevelBars(levelFraction: levelFraction),
            progressTrack: ProgressTrack(
              fraction: recordedFraction(secondsLeft),
              fillColour: colours.accent,
            ),
            // "8 seconds left", "1 second left", "0 seconds left".
            countdown: words.listeningSecondsLeft(secondsLeft),
          ),
        ),
        footer: [OutlinedButton(onPressed: flow.backToHome, child: Text(words.cancelButton))],
      ),
    );
  }
}
