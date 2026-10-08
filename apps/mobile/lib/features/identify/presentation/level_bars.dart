import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// The Listening screen's level meter (design §2.4; wireframe Listening): 16 bars of fixed,
/// uneven heights in a 48 dp row, the first round(level × 16) of them in the accent colour and the
/// rest in the line colour. It follows the state with no animation of its own.
///
/// Hidden from screen readers: "Listening…" and the countdown already say what is happening.
class LevelBars extends StatelessWidget {
  const LevelBars({super.key, required this.levelFraction});

  /// The live input level, 0 (silence) to 1.
  final double levelFraction;

  /// How many bars there are.
  static const int barCount = 16;

  /// The wireframe's bar heights (10, 18, 26, 14, 32, 42, 22, 30, 46, 36, 20, 28, 16, 24, 12 and
  /// 8 dp), counted in steps of half the smallest spacing token (2 dp), so no size is written here
  /// outside the tokens.
  static const List<int> barHeightSteps = [
    5,
    9,
    13,
    7,
    16,
    21,
    11,
    15,
    23,
    18,
    10,
    14,
    8,
    12,
    6,
    4,
  ];

  /// How many bars are lit at [levelFraction].
  static int litBarCount(double levelFraction) {
    final level = levelFraction.isNaN ? 0.0 : levelFraction.clamp(0.0, 1.0);
    return (level * barCount).round();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final heightStep = spacing.space1 / 2;
    // 6 dp wide, 4 dp apart, with fully rounded ends.
    final barWidth = spacing.space1 * 1.5;
    final litCount = litBarCount(levelFraction);
    return ExcludeSemantics(
      child: SizedBox(
        height: spacing.space12,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (index, heightSteps) in barHeightSteps.indexed) ...[
              if (index > 0) SizedBox(width: spacing.space1),
              SizedBox(
                width: barWidth,
                height: heightSteps * heightStep,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: index < litCount ? colours.accent : colours.line,
                    borderRadius: BorderRadius.circular(barWidth / 2),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
