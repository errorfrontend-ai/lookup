import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// Home's one big control (design §2.2; wireframe Main): a 200 dp accent disc with the microphone
/// above "Tap to identify", inside two soft halo rings, low on the screen where a thumb reaches it.
///
/// Screen readers hear "Identify the ad playing now", a button: the drawn words assume the
/// listener can see the disc. The circle keeps its size at large text sizes; its words wrap and,
/// if they still do not fit, shrink to fit inside it rather than spill out of it.
class IdentifyButton extends StatelessWidget {
  const IdentifyButton({super.key, required this.onPressed});

  /// The words drawn on the disc.
  static const String label = 'Tap to identify';

  /// What screen readers announce.
  static const String semanticsLabel = 'Identify the ad playing now';

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    // 200 dp across, a 56 dp icon; rings 12 and 28 dp wide (the wireframe's 14 dp ring is taken to
    // the nearest token, design §2.1).
    final diameter = spacing.space10 * 5;
    final innerRingWidth = spacing.space3;
    final outerRingWidth = spacing.space6 + spacing.space1;
    final contentPadding = spacing.space4;
    return Semantics(
      button: true,
      label: semanticsLabel,
      onTap: onPressed,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          // Painted in order: the wider, fainter ring first, the accent-soft ring on it.
          boxShadow: [
            BoxShadow(
              color: colours.accentSoft.withValues(alpha: 0.5),
              spreadRadius: outerRingWidth,
            ),
            BoxShadow(color: colours.accentSoft, spreadRadius: innerRingWidth),
          ],
        ),
        child: Material(
          color: colours.accent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox.square(
              dimension: diameter,
              child: Padding(
                padding: EdgeInsets.all(contentPadding),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: SizedBox(
                    width: diameter - 2 * contentPadding,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.mic_none, size: spacing.space14, color: colours.onAccent),
                        SizedBox(height: spacing.space2),
                        Text(
                          label,
                          textAlign: TextAlign.center,
                          style: tokens.typeStyles.heading.copyWith(
                            fontWeight: FontWeight.w700,
                            color: colours.onAccent,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
