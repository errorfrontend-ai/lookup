import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/level_ring.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';

/// Identifying, the `uploading` state at `/identifying` (design §2.5, S4-D28; no wireframe): the
/// Listening layout with the ring still and no level bars, while the app gets an install token
/// when it needs one, sends the clip, and resends silently after a 409 or a 401 (T15, T22, T23).
///
/// "Cancel", the Close × and system Back abort the request, delete the clip and lead Home (T28).
/// The bar for the unknown wait breathes by opacity and stands still when the phone asks for less
/// motion.
class IdentifyingScreen extends ConsumerWidget {
  const IdentifyingScreen({super.key});

  static const String heading = 'Identifying…';

  static const String explanation = 'This usually takes a few seconds.';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final flow = ref.read(recognitionFlowProvider.notifier);
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: 'Cancel identifying', onPressed: flow.backToHome),
        body: Expanded(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const LevelRing(levelFraction: 0),
                SizedBox(height: spacing.space1),
                const StateHeading(
                  heading,
                  role: SemanticsRole.status,
                  textAlign: TextAlign.center,
                ),
                SizedBox(height: spacing.space2),
                Text(
                  explanation,
                  textAlign: TextAlign.center,
                  style: tokens.typeStyles.body.copyWith(color: colours.muted),
                ),
                SizedBox(height: spacing.space6),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: spacing.space10 * 5 + spacing.space5),
                  child: ProgressTrack(fillColour: colours.accent),
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
