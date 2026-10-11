import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// No match, the `noMatch` state at `/no-match` (design §2.8; wireframe NoMatch): the clip was heard
/// but not recognised, with three things to try. "Try again" starts a new listening, the
/// permission checked first (T36); Close ×, "Back to home" and system Back lead Home (T38).
class NoMatchScreen extends ConsumerWidget {
  const NoMatchScreen({super.key});

  /// The tips, in the order the panel numbers them.
  static List<String> tipsOf(AppLocalizations words) => [
    words.noMatchTipTurnUp,
    words.noMatchTipTapDuringAd,
    words.noMatchTipStepAway,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final flow = ref.read(recognitionFlowProvider.notifier);
    final words = AppLocalizations.of(context);
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: words.closeButton, onPressed: flow.backToHome),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(
              icon: Icons.search,
              iconColour: colours.muted,
              circleColour: colours.lineSoft,
            ),
            SizedBox(height: spacing.space5),
            StateHeading(words.noMatchHeading, role: SemanticsRole.status),
            SizedBox(height: spacing.space2),
            Text(
              words.noMatchExplanation,
              style: tokens.typeStyles.body.copyWith(color: colours.muted),
            ),
            SizedBox(height: spacing.space5),
            const _TipsPanel(),
          ],
        ),
        footer: [
          FilledButton(
            onPressed: () => unawaited(flow.tryAgain()),
            child: Text(words.tryAgainButton),
          ),
          TextButton(onPressed: flow.backToHome, child: Text(words.backToHomeButton)),
        ],
      ),
    );
  }
}

/// "Try this" and the numbered tips: read as a list of three items, without the drawn numbers.
class _TipsPanel extends StatelessWidget {
  const _TipsPanel();

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colours.surface,
        border: Border.all(color: colours.lineSoft),
        borderRadius: BorderRadius.circular(tokens.radii.large),
      ),
      child: Padding(
        padding: EdgeInsets.all(spacing.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              header: true,
              child: Text(
                words.noMatchTipsHeading,
                style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            SizedBox(height: spacing.space3),
            Semantics(
              container: true,
              role: SemanticsRole.list,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (index, tip) in NoMatchScreen.tipsOf(words).indexed) ...[
                    if (index > 0) SizedBox(height: spacing.space3),
                    Semantics(
                      container: true,
                      role: SemanticsRole.listItem,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _NumberBadge(number: index + 1),
                          SizedBox(width: spacing.space3),
                          Expanded(child: Text(tip, style: typeStyles.body)),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The 24 dp numbered circle before a tip. Hidden from screen readers, which announce the list's
/// own order; the digit shrinks to fit the circle at large text sizes instead of spilling out.
class _NumberBadge extends StatelessWidget {
  const _NumberBadge({required this.number});

  final int number;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: tokens.spacing.space6,
        child: DecoratedBox(
          decoration: BoxDecoration(color: colours.accentSoft, shape: BoxShape.circle),
          child: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                '$number',
                style: tokens.typeStyles.caption.copyWith(
                  color: colours.accentHover,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
