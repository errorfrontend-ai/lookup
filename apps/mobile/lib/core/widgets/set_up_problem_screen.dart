import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
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

  /// What the configuration check found.
  final List<ConfigurationProblem> problems;

  /// True only for a development build (`AppConfigurationRefused.isDevelopmentBuild`).
  final bool showsProblems;

  /// What is wrong, in words a developer can act on: the setting and the rule it breaks, never its
  /// value. Shown only in a development build.
  static String describe(ConfigurationProblem problem, AppLocalizations words) => switch (problem) {
    ConfigurationProblem.flavourNotRecognised => words.configurationProblemFlavourNotRecognised,
    ConfigurationProblem.gradleFlavourDiffers => words.configurationProblemGradleFlavourDiffers,
    ConfigurationProblem.apiBaseUrlMissing => words.configurationProblemApiBaseUrlMissing,
    ConfigurationProblem.apiBaseUrlMalformed => words.configurationProblemApiBaseUrlMalformed,
    ConfigurationProblem.apiBaseUrlNotEndingApiVersion1 =>
      words.configurationProblemApiBaseUrlNotEndingApiVersion1,
    ConfigurationProblem.apiBaseUrlNotHttps => words.configurationProblemApiBaseUrlNotHttps,
    ConfigurationProblem.errorDetailsFlagNotTrueOrFalse =>
      words.configurationProblemErrorDetailsFlagNotTrueOrFalse,
    ConfigurationProblem.errorDetailsOutsideDevelopment =>
      words.configurationProblemErrorDetailsOutsideDevelopment,
    ConfigurationProblem.developerToolsFlagNotTrueOrFalse =>
      words.configurationProblemDeveloperToolsFlagNotTrueOrFalse,
    ConfigurationProblem.developerToolsOutsideDevelopment =>
      words.configurationProblemDeveloperToolsOutsideDevelopment,
    ConfigurationProblem.verboseLogsFlagNotTrueOrFalse =>
      words.configurationProblemVerboseLogsFlagNotTrueOrFalse,
    ConfigurationProblem.verboseLogsOutsideDevelopment =>
      words.configurationProblemVerboseLogsOutsideDevelopment,
    ConfigurationProblem.supportWhatsAppNumberMissing =>
      words.configurationProblemSupportWhatsAppNumberMissing,
    ConfigurationProblem.outboxSendingDelayNotWholeSeconds =>
      words.configurationProblemOutboxSendingDelayNotWholeSeconds,
    ConfigurationProblem.outboxSendingDelayOutsideDevelopment =>
      words.configurationProblemOutboxSendingDelayOutsideDevelopment,
    ConfigurationProblem.outboxBackoffFirstWaitNotWholeSeconds =>
      words.configurationProblemOutboxBackoffFirstWaitNotWholeSeconds,
    ConfigurationProblem.outboxBackoffFirstWaitOutsideDevelopment =>
      words.configurationProblemOutboxBackoffFirstWaitOutsideDevelopment,
    ConfigurationProblem.supportWhatsAppNumberNotE164 =>
      words.configurationProblemSupportWhatsAppNumberNotE164,
  };

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
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
          Semantics(
            header: true,
            child: Text(words.setUpProblemHeading, style: typeStyles.headline),
          ),
          if (showsProblems && problems.isNotEmpty) ...[
            SizedBox(height: spacing.space5),
            Text(words.developmentOnlyDetails, style: typeStyles.label),
            for (final problem in problems) ...[
              SizedBox(height: spacing.space2),
              Text(describe(problem, words), style: typeStyles.body.copyWith(color: colours.muted)),
            ],
          ],
        ],
      ),
    );
  }
}
