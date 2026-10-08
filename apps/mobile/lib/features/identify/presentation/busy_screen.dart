import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/presentation/progress_track.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';

/// Busy, the `busy` state at `/busy` (design §2.9; wireframe Busy): the API had no room, so the app
/// kept the clip and counts down to sending it again by itself (T29, T30), the wait starting from
/// the API's `Retry-After`. The countdown pauses while the app is in the background (S4-D23).
///
/// "Try now" sends at once and stops the countdown (T32); Close ×, "Cancel" and system Back stop
/// it, drop the kept clip and lead Home (T33).
class BusyScreen extends ConsumerWidget {
  const BusyScreen({super.key, required this.retryDelaySeconds, required this.secondsUntilRetry});

  /// The whole wait, against which the bar shows progress.
  final int retryDelaySeconds;

  /// The countdown, e.g. 12 for "12 s".
  final int secondsUntilRetry;

  static const String heading = 'Lots of people are listening right now';

  static const String explanation =
      "We kept your clip and will try again automatically. You don't need to record again.";

  static const String countdownLabel = 'Trying again in';

  /// "12 s", as drawn.
  static String countdownText(int seconds) => '$seconds s';

  /// "12 seconds", for screen readers, which would read "s" as a letter.
  static String countdownSemanticsLabel(int seconds) =>
      seconds == 1 ? '1 second' : '$seconds seconds';

  /// How much of the wait has passed: 0 when it starts, 1 at the send.
  static double waitedFraction({required int retryDelaySeconds, required int secondsUntilRetry}) {
    if (retryDelaySeconds <= 0) return 1;
    return ((retryDelaySeconds - secondsUntilRetry) / retryDelaySeconds).clamp(0.0, 1.0);
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
        exitButton: ScreenExitButton.close(label: 'Close', onPressed: flow.backToHome),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(
              icon: Icons.refresh,
              iconColour: colours.warning,
              circleColour: colours.warningSoft,
            ),
            SizedBox(height: spacing.space5),
            const StateHeading(heading, role: SemanticsRole.status),
            SizedBox(height: spacing.space2),
            Text(explanation, style: typeStyles.body.copyWith(color: colours.muted)),
            SizedBox(height: spacing.space5),
            // A polite live region: the countdown is announced as it changes.
            Semantics(
              container: true,
              liveRegion: true,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colours.surface,
                  border: Border.all(color: colours.lineSoft),
                  borderRadius: BorderRadius.circular(tokens.radii.large),
                ),
                child: Padding(
                  padding: EdgeInsets.all(spacing.space5),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // One line with the countdown at the end; two lines when the text is large.
                      Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.end,
                        spacing: spacing.space3,
                        children: [
                          Text(
                            countdownLabel,
                            style: typeStyles.body.copyWith(fontWeight: FontWeight.w600),
                          ),
                          Text(
                            countdownText(secondsUntilRetry),
                            semanticsLabel: countdownSemanticsLabel(secondsUntilRetry),
                            // Tabular figures, so the number does not shift as it counts down.
                            style: typeStyles.display.copyWith(
                              fontFeatures: const [FontFeature.tabularFigures()],
                            ),
                          ),
                        ],
                      ),
                      SizedBox(height: spacing.space3),
                      ProgressTrack(
                        fraction: waitedFraction(
                          retryDelaySeconds: retryDelaySeconds,
                          secondsUntilRetry: secondsUntilRetry,
                        ),
                        fillColour: colours.warning,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
        footer: [
          FilledButton(onPressed: () => unawaited(flow.tryNow()), child: const Text('Try now')),
          TextButton(onPressed: flow.backToHome, child: const Text('Cancel')),
        ],
      ),
    );
  }
}
