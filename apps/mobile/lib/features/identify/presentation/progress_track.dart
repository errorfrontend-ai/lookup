import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// The thin progress bar of the Listening, Identifying and Busy screens (design §2.4, §2.5, §2.9):
/// a 6 dp track in the line-soft colour, filled from the start by [fraction] in [fillColour], as
/// wide as its parent allows.
///
/// With no [fraction] the length of the wait is unknown (Identifying): a short bar in the middle
/// of the track breathes in and out, by opacity only, and stands still when the phone asks for
/// less motion. A determinate bar never animates; it simply follows the state.
///
/// Hidden from screen readers: the countdown or heading beside it says the same in words.
class ProgressTrack extends StatefulWidget {
  const ProgressTrack({super.key, required this.fillColour, this.fraction});

  /// How much is done, 0 to 1; null while the length of the wait is unknown.
  final double? fraction;

  /// The fill: the accent while listening and identifying, the warning colour on Busy.
  final Color fillColour;

  /// How much of the track the bar of an unknown wait covers.
  static const double unknownWaitBarFraction = 0.4;

  /// The faintest the bar of an unknown wait becomes as it breathes.
  static const double unknownWaitFaintestOpacity = 0.3;

  @override
  State<ProgressTrack> createState() => _ProgressTrackState();
}

class _ProgressTrackState extends State<ProgressTrack> with SingleTickerProviderStateMixin {
  AnimationController? _breathing;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _followMotionSetting();
  }

  @override
  void didUpdateWidget(ProgressTrack oldWidget) {
    super.didUpdateWidget(oldWidget);
    _followMotionSetting();
  }

  /// Breathes only for an unknown wait and only while the phone allows motion.
  void _followMotionSetting() {
    final breathes = widget.fraction == null && !MediaQuery.disableAnimationsOf(context);
    final breathing = _breathing;
    if (breathes && breathing == null) {
      _breathing = AnimationController(vsync: this, duration: context.lookUpTokens.motion.slow)
        ..repeat(reverse: true);
    } else if (!breathes && breathing != null) {
      breathing.dispose();
      _breathing = null;
    }
  }

  @override
  void dispose() {
    _breathing?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    // 6 dp: one and a half of the smallest spacing step, as the wireframes draw the track.
    final trackHeight = tokens.spacing.space1 * 1.5;
    final fraction = widget.fraction;
    Widget bar = ColoredBox(color: widget.fillColour);
    final breathing = _breathing;
    if (breathing != null) {
      bar = FadeTransition(
        opacity: Tween<double>(
          begin: ProgressTrack.unknownWaitFaintestOpacity,
          end: 1,
        ).animate(breathing),
        child: bar,
      );
    }
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(tokens.radii.pill),
        child: SizedBox(
          width: double.infinity,
          height: trackHeight,
          child: ColoredBox(
            color: tokens.colours.lineSoft,
            child: Align(
              alignment: fraction == null ? Alignment.center : AlignmentDirectional.centerStart,
              child: FractionallySizedBox(
                widthFactor: fraction?.clamp(0.0, 1.0) ?? ProgressTrack.unknownWaitBarFraction,
                heightFactor: 1,
                child: bar,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
