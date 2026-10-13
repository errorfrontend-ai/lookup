import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// History before anything was identified (P6 design §2.9; P6-HISTORY-13; no wireframe, gap 4): an
/// 88 dp line-soft circle with a clock, "No results yet" as a heading, and what History is for,
/// instead of empty sections.
class HistoryEmptyState extends StatelessWidget {
  const HistoryEmptyState({super.key});

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    return Padding(
      padding: EdgeInsets.only(top: spacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StateIconCircle(
            icon: Icons.schedule,
            iconColour: colours.muted,
            circleColour: colours.lineSoft,
            alignment: Alignment.center,
          ),
          SizedBox(height: spacing.space5),
          Semantics(
            header: true,
            child: Text(
              words.historyEmptyHeading,
              textAlign: TextAlign.center,
              style: typeStyles.heading,
            ),
          ),
          SizedBox(height: spacing.space2),
          Text(
            words.historyEmptyExplanation,
            textAlign: TextAlign.center,
            style: typeStyles.body.copyWith(color: colours.muted),
          ),
        ],
      ),
    );
  }
}
