import 'package:flutter/material.dart';

import '../configuration/configuration_problem.dart';
import '../theme/look_up_tokens.dart';
import 'screen_frame.dart';
import 'state_icon_circle.dart';

/// The one screen a wrongly built copy of the app shows instead of starting (design §2.11): no or a
/// malformed API address, plain `http` outside development, flavours that disagree. It makes no
/// request and reports nothing, because no setting can be trusted to say where to send anything,
/// and it offers no button, because there is nowhere to go. This never happens to a listener's
/// correct install.
///
/// A development build also lists the problems under "Details (development only)", so the
/// developer sees what to fix; the listener-facing words never change.
class SetUpProblemScreen extends StatelessWidget {
  const SetUpProblemScreen({super.key, required this.problems, this.showsProblems = false});

  /// The words every build shows.
  static const String heading = "This copy of Look Up isn't set up correctly.";

  /// The heading of the development-only list.
  static const String detailsHeading = 'Details (development only)';

  /// What the configuration check found.
  final List<ConfigurationProblem> problems;

  /// True only for a development build (`AppConfigurationRefused.isDevelopmentBuild`).
  final bool showsProblems;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    return ScreenFrame(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StateIconCircle(
            icon: Icons.warning_amber_rounded,
            iconColour: colours.danger,
            circleColour: colours.dangerSoft,
          ),
          SizedBox(height: spacing.space5),
          Semantics(header: true, child: Text(heading, style: typeStyles.headline)),
          if (showsProblems && problems.isNotEmpty) ...[
            SizedBox(height: spacing.space5),
            Text(detailsHeading, style: typeStyles.label),
            for (final problem in problems) ...[
              SizedBox(height: spacing.space2),
              Text(
                problem.developerDescription,
                style: typeStyles.body.copyWith(color: colours.muted),
              ),
            ],
          ],
        ],
      ),
    );
  }
}
