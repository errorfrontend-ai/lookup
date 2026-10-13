import 'package:flutter/material.dart';

import '../theme/look_up_tokens.dart';

/// A section's heading on the tab screens (P6 design §2.9, §2.11; wireframes History and Settings):
/// "EARLIER", "LISTENING", "APP" — the caption size, bold, muted and drawn in capitals, as the
/// wireframes draw them, while screen readers hear the words in their own case and as a heading.
class SectionHeading extends StatelessWidget {
  const SectionHeading({super.key, required this.text});

  /// The heading in its own case, e.g. "Earlier", from the language file.
  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return Semantics(
      header: true,
      label: text,
      excludeSemantics: true,
      child: Text(
        text.toUpperCase(),
        style: tokens.typeStyles.caption.copyWith(
          color: tokens.colours.muted,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
