import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// "More options" under the fourth button of a card with five or six (S4-D18): a full-width text
/// button with a chevron that reveals the rest of the buttons in place. Its list removes it once
/// pressed, so it never becomes a control that does nothing.
class MoreOptionsButton extends StatelessWidget {
  const MoreOptionsButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: onPressed,
      // The chevron follows the words, as a "show more" control reads; it is decorative.
      iconAlignment: IconAlignment.end,
      icon: Icon(Icons.expand_more, size: context.lookUpTokens.spacing.space5),
      label: const Text('More options'),
    );
  }
}
