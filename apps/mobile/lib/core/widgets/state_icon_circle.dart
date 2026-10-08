import 'package:flutter/material.dart';

import '../theme/look_up_tokens.dart';

/// The round icon at the top of the Permission, No match, Busy and Error screens (design §2.3,
/// §2.8–§2.10): an 88 dp circle in a soft colour with a 40 dp icon in the matching strong colour,
/// e.g. danger on danger-soft. Decorative: the heading beside it says the same thing, so screen
/// readers skip it.
class StateIconCircle extends StatelessWidget {
  const StateIconCircle({
    super.key,
    required this.icon,
    required this.iconColour,
    required this.circleColour,
    this.alignment = AlignmentDirectional.centerStart,
  });

  final IconData icon;

  /// The strong colour, from the tokens (e.g. `colours.danger`).
  final Color iconColour;

  /// The soft colour, from the tokens (e.g. `colours.dangerSoft`).
  final Color circleColour;

  /// Where the circle sits across the screen: at the start, as the wireframes draw it.
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    // 88 dp: the 40 dp icon with 24 dp all round, both token values.
    return ExcludeSemantics(
      child: Align(
        alignment: alignment,
        child: DecoratedBox(
          decoration: BoxDecoration(color: circleColour, shape: BoxShape.circle),
          child: Padding(
            padding: EdgeInsets.all(spacing.space6),
            child: Icon(icon, size: spacing.space10, color: iconColour),
          ),
        ),
      ),
    );
  }
}
