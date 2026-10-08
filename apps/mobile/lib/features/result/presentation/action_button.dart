import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';

/// One of the station's buttons on the Result screen (design §2.6, §3.13): full width (its list
/// stretches it), at least 52 dp tall through the theme, the type's 20 dp icon before the label
/// when there is room, and the label as the station wrote it.
///
/// The style the station chose picks the Material variant (S4-RENDERER-06 to -08); the colours
/// come from the theme, which takes them from the tokens.
class ActionButton extends StatelessWidget {
  const ActionButton({
    super.key,
    required this.label,
    required this.style,
    required this.onPressed,
    this.icon,
  });

  /// Labels up to this many code points are shown whole: the contract's limit, which a 320 dp
  /// phone fits on one line.
  static const int longestWholeLabelCodePoints = 32;

  /// The station's label, whole.
  final String label;

  final ActionStyle style;

  final VoidCallback onPressed;

  /// The type's icon, or null to show the label alone (below 360 dp, as Result320 draws).
  final IconData? icon;

  /// [label] as shown: whole up to [longestWholeLabelCodePoints] code points, otherwise its first
  /// 31 followed by "…" (S4-D20). Counted in code points, as the contract counts, so an emoji is
  /// one character and never cut in half.
  static String shownLabelFor(String label) {
    final codePoints = label.runes;
    if (codePoints.length <= longestWholeLabelCodePoints) return label;
    final keptCodePoints = codePoints.take(longestWholeLabelCodePoints - 1);
    return '${String.fromCharCodes(keptCodePoints)}\u2026';
  }

  @override
  Widget build(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    // Screen readers always get the whole label, even when the screen shows it shortened. The text
    // may wrap at large text sizes rather than be cut (S4-RESPONSIVE-03).
    final labelText = Text(
      shownLabelFor(label),
      semanticsLabel: label,
      textAlign: TextAlign.center,
    );
    final icon = this.icon;
    final content = icon == null
        ? labelText
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Decorative: the label already says what the button does.
              Icon(icon, size: spacing.space5),
              SizedBox(width: spacing.space2),
              Flexible(child: labelText),
            ],
          );
    return switch (style) {
      ActionStyle.primary => FilledButton(onPressed: onPressed, child: content),
      ActionStyle.secondary => FilledButton.tonal(onPressed: onPressed, child: content),
      ActionStyle.outline => OutlinedButton(onPressed: onPressed, child: content),
    };
  }
}
