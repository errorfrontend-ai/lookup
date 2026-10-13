import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/listening_layout.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Identifying, the `uploading` state at `/identifying` (design §2.5, S4-D28; no wireframe): the
/// Listening layout with the ring still, in the same place, and no level bars or countdown (their
/// rows are kept empty, `ListeningLayout`), while the app gets an install token
/// when it needs one, sends the clip, and resends silently after a 409 or a 401 (T15, T22, T23).
///
/// "Cancel", the Close × and system Back abort the request, delete the clip and lead Home (T28).
/// The bar for the unknown wait breathes by opacity and stands still when the phone asks for less
/// motion.
class IdentifyingScreen extends ConsumerWidget {
  const IdentifyingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colours = context.lookUpTokens.colours;
    final flow = ref.read(recognitionFlowProvider.notifier);
    final words = AppLocalizations.of(context);
    // After 5 seconds with no answer: the connection is slow, and the bar shows the share sent
    // (P6 design §2.5, P6-LISTENING-01).
    final slow = switch (ref.watch(recognitionFlowProvider)) {
      UploadingState(isSlow: true, :final sentPercent) => sentPercent,
      _ => null,
    };
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(
          label: words.cancelIdentifyingLabel,
          onPressed: flow.backToHome,
        ),
        // Listening's layout, so the ring stays exactly where it was: the rows of the level bars and
        // the countdown are kept empty, and the words keep the room of Listening's.
        body: Expanded(
          child: ListeningLayout(
            ring: const LevelRing(levelFraction: 0),
            heading: words.identifyingHeading,
            headingToFit: words.listeningHeading,
            text: slow == null ? words.identifyingExplanation : words.identifyingSlow,
            textToFit: words.listeningInstruction,
            isTextAnnounced: slow != null,
            progressTrack: ProgressTrack(
              fillColour: colours.accent,
              fraction: slow == null ? null : slow / 100,
            ),
            countdown: switch (slow) {
              null => null,
              100 => words.identifyingClipSent,
              final percent => words.identifyingClipPercentSent(percent),
            },
            countdownToFit: words.listeningSecondsLeft(
              RecognitionFlow.clipSettings.clipDurationSeconds,
            ),
          ),
        ),
        footer: [OutlinedButton(onPressed: flow.backToHome, child: Text(words.cancelButton))],
      ),
    );
  }
}
