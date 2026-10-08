import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// The Listening screen's ring (design §2.4; wireframe Listening): a round accent disc with the
/// microphone, inside three soft halo rings that grow with the live input level, so the listener
/// sees the phone hearing the radio. Identifying shows it still, at level 0 (§2.5).
///
/// Decorative and not tappable (S4-D1: the wireframe's tap-to-finish was a prototype shortcut), so
/// it is hidden from screen readers. Only the rings move, by scale alone (scale = 1 + 0.15 × level)
/// over motion.fast, and not at all when the phone asks for less motion.
///
/// Its box includes the outer ring, so the halo never reaches the header above it; on a screen
/// narrower than the halo the box takes the width it has and the rings paint past its sides.
class LevelRing extends StatelessWidget {
  const LevelRing({super.key, required this.levelFraction});

  /// The live input level, 0 (silence) to 1.
  final double levelFraction;

  /// How much the rings grow at the loudest level.
  static const double growthAtLoudestLevel = 0.15;

  /// The rings' scale for [levelFraction]: 1 in silence, 1.15 at the loudest.
  static double ringScaleFor(double levelFraction) {
    final level = levelFraction.isNaN ? 0.0 : levelFraction.clamp(0.0, 1.0);
    return 1 + growthAtLoudestLevel * level;
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    // 164 dp disc with a 52 dp icon; rings 20, 40 and 60 dp wide (the wireframe's 18 and 38 are
    // taken to the nearest tokens, design §2.1).
    final discDiameter = spacing.space10 * 4 + spacing.space1;
    final iconSize = spacing.space12 + spacing.space1;
    final innerRingWidth = spacing.space5;
    final middleRingWidth = spacing.space10;
    final outerRingWidth = spacing.space12 + spacing.space3;
    final animationDuration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : tokens.motion.fast;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: discDiameter + 2 * outerRingWidth,
        child: Center(
          child: Stack(
            alignment: Alignment.center,
            clipBehavior: Clip.none,
            children: [
              AnimatedScale(
                scale: ringScaleFor(levelFraction),
                duration: animationDuration,
                child: SizedBox.square(
                  dimension: discDiameter,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      // Painted in order, so the widest ring goes first and the others lie on it:
                      // the soft accent, half-faded outside it, and a touch of accent inside.
                      boxShadow: [
                        BoxShadow(
                          color: colours.accentSoft.withValues(alpha: 0.5),
                          spreadRadius: outerRingWidth,
                        ),
                        BoxShadow(color: colours.accentSoft, spreadRadius: middleRingWidth),
                        BoxShadow(
                          color: colours.accent.withValues(alpha: 0.08),
                          spreadRadius: innerRingWidth,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              SizedBox.square(
                dimension: discDiameter,
                child: DecoratedBox(
                  decoration: BoxDecoration(color: colours.accent, shape: BoxShape.circle),
                  child: Icon(Icons.mic_none, size: iconSize, color: colours.onAccent),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
