import 'package:flutter/material.dart';

import '../theme/look_up_tokens.dart';

/// The one icon button at a screen's top left: a Back arrow or a Close ×, 48 × 48 dp, with the label
/// screen readers announce (design §2.1). Each screen words its label ("Back", "Back to home",
/// "Close", "Cancel listening"), so the caller gives it.
class ScreenExitButton extends StatelessWidget {
  /// A Back arrow, for screens that return to where the listener came from.
  const ScreenExitButton.back({super.key, required this.label, required this.onPressed})
    : icon = Icons.arrow_back;

  /// A Close ×, for screens that end what was under way.
  const ScreenExitButton.close({super.key, required this.label, required this.onPressed})
    : icon = Icons.close;

  /// What a screen reader announces, like the wireframes' `aria-label`.
  final String label;

  /// What the button does; system back should do the same (design §2.1).
  final VoidCallback onPressed;

  /// The arrow or the cross.
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final touchTargetMinimum = context.lookUpTokens.sizes.touchTargetMinimum;
    return IconButton(
      onPressed: onPressed,
      // The icon's label becomes the button's name for screen readers.
      icon: Icon(icon, semanticLabel: label),
      constraints: BoxConstraints.tightFor(width: touchTargetMinimum, height: touchTargetMinimum),
    );
  }
}
