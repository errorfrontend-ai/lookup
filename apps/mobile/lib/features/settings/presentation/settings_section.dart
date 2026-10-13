import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/section_heading.dart';

/// A section of rows (P6 design §2.11, §2.12; wireframe Settings): its heading in capitals, as in
/// History, then the rows in one white card with a line-soft border and large corners, a line-soft
/// rule between rows.
class SettingsSection extends StatelessWidget {
  const SettingsSection({super.key, required this.rows, this.heading});

  /// The section's heading, e.g. "Listening"; null for a card with no heading of its own.
  final String? heading;

  /// The rows, top to bottom.
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final heading = this.heading;
    final shape = BorderRadius.circular(tokens.radii.large);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (heading != null) ...[
          SectionHeading(text: heading),
          SizedBox(height: tokens.spacing.space2),
        ],
        DecoratedBox(
          position: DecorationPosition.foreground,
          decoration: BoxDecoration(
            border: Border.all(color: colours.lineSoft),
            borderRadius: shape,
          ),
          child: ClipRRect(
            borderRadius: shape,
            child: Material(
              color: colours.surface,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (index, row) in rows.indexed) ...[
                    if (index > 0) Divider(height: 1, thickness: 1, color: colours.lineSoft),
                    row,
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
