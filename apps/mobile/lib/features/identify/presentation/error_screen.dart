import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/identifiers/reference_code.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/reference_code_panel.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/features/identify/presentation/support_chat_button.dart';
import 'package:lookup_listener/features/identify/presentation/system_back_to_home.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Error, the `error` state at `/error` (design §2.10, S4-D10, S4-D28; wireframe Error): one layout
/// for the six failures, each with its own icon, heading, words and buttons, chosen by an
/// exhaustive switch over [failure], so a seventh failure cannot compile without its screen.
///
/// - A reference code is shown only for a request id the API logged, or for a crash report it
///   accepted (S4-D9), so "share this code with support" is only said when support can find it.
///   With a support number in the build, "Message support on WhatsApp" sits under it (S4-D32).
/// - The words are the app's own: no exception text, status line or API `message` (S4-D13).
/// - A development build with `LOOKUP_SHOW_ERROR_DETAILS` adds "Details (development only)"; no
///   other build can (S4-ERRORHANDLING-08).
///
/// Close ×, "Back to home" and system Back drop any kept clip and lead Home (T38).
class ErrorScreen extends ConsumerWidget {
  const ErrorScreen({super.key, required this.failure});

  final RecognitionFailure failure;

  /// What [failure] looks like and says.
  static _ErrorWording _wordingFor(
    RecognitionFailure failure,
    LookUpColours colours,
    AppLocalizations words,
  ) {
    return switch (failure) {
      ServerFailure() => _ErrorWording(
        icon: Icons.warning_amber_rounded,
        iconColour: colours.danger,
        circleColour: colours.dangerSoft,
        heading: words.errorSomethingWentWrongHeading,
        headingRole: SemanticsRole.alert,
        explanation: words.errorExplanationWithCode,
        footer: _ErrorFooter.tryAgain,
      ),
      PhoneFailure(:final reportDelivery) => _ErrorWording(
        icon: Icons.warning_amber_rounded,
        iconColour: colours.danger,
        circleColour: colours.dangerSoft,
        heading: words.errorSomethingWentWrongHeading,
        headingRole: SemanticsRole.alert,
        // Until the API has accepted the report there is no code to share.
        explanation: reportDelivery == ReportDelivery.accepted
            ? words.errorExplanationWithCode
            : words.errorExplanationTryAgain,
        footer: _ErrorFooter.tryAgain,
      ),
      RecordingUnusableFailure() => _ErrorWording(
        icon: Icons.mic_off_outlined,
        iconColour: colours.ink,
        circleColour: colours.lineSoft,
        heading: words.errorRecordingUnusableHeading,
        headingRole: SemanticsRole.status,
        explanation: words.errorRecordingUnusableExplanation,
        footer: _ErrorFooter.tryAgain,
      ),
      ConnectionFailure() => _ErrorWording(
        icon: Icons.signal_cellular_off_outlined,
        iconColour: colours.ink,
        circleColour: colours.lineSoft,
        heading: words.errorNoConnectionHeading,
        headingRole: SemanticsRole.status,
        explanation: words.errorNoConnectionExplanation,
        footer: _ErrorFooter.sendAgain,
      ),
      TooManyTriesFailure(:final isShortWait) => _ErrorWording(
        icon: Icons.schedule,
        iconColour: colours.warning,
        circleColour: colours.warningSoft,
        heading: words.errorTooManyTriesHeading,
        headingRole: SemanticsRole.status,
        explanation: isShortWait
            ? words.errorTooManyTriesShortWaitExplanation
            : words.errorTooManyTriesLaterExplanation,
        footer: _ErrorFooter.backToHomeOnly,
      ),
      // An answer this version cannot show; CHOOSE_STATION is the chooser now (P6 design §2.15).
      NewerAppNeededFailure() => _ErrorWording(
        icon: Icons.info_outline,
        iconColour: colours.accent,
        circleColour: colours.accentSoft,
        heading: words.errorNewerAppHeading,
        headingRole: SemanticsRole.status,
        explanation: words.errorNewerAppUnknownAnswerExplanation,
        footer: _ErrorFooter.backToHomeOnly,
      ),
    };
  }

  /// The code shown for [failure], e.g. "6F1C-2D3E", or null when none may be shown.
  static String? referenceCodeFor(RecognitionFailure failure) {
    final requestId = failure.referenceCodeRequestId;
    return requestId == null ? null : ReferenceCode.forRequestId(requestId);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final configuration = ref.watch(appConfigurationProvider);
    final flow = ref.read(recognitionFlowProvider.notifier);
    final words = AppLocalizations.of(context);
    final wording = _wordingFor(failure, colours, words);
    final referenceCode = referenceCodeFor(failure);
    final supportWhatsAppNumber = configuration.supportWhatsAppNumber;
    final backToHomeLabel = Text(words.backToHomeButton);
    return SystemBackToHome(
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: words.closeButton, onPressed: flow.backToHome),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(
              icon: wording.icon,
              iconColour: wording.iconColour,
              circleColour: wording.circleColour,
            ),
            SizedBox(height: spacing.space5),
            StateHeading(wording.heading, role: wording.headingRole),
            SizedBox(height: spacing.space2),
            Text(wording.explanation, style: tokens.typeStyles.body.copyWith(color: colours.muted)),
            if (referenceCode != null) ...[
              SizedBox(height: spacing.space5),
              ReferenceCodePanel(referenceCode: referenceCode),
              if (supportWhatsAppNumber != null) ...[
                SizedBox(height: spacing.space2),
                SupportChatButton(
                  supportWhatsAppNumber: supportWhatsAppNumber,
                  referenceCode: referenceCode,
                ),
              ],
            ],
            if (configuration.showsErrorDetails) ...[
              SizedBox(height: spacing.space3),
              _DevelopmentDetails(failure: failure),
            ],
          ],
        ),
        footer: switch (wording.footer) {
          _ErrorFooter.tryAgain => [
            FilledButton(
              onPressed: () => unawaited(flow.tryAgain()),
              child: Text(words.tryAgainButton),
            ),
            TextButton(onPressed: flow.backToHome, child: backToHomeLabel),
          ],
          _ErrorFooter.sendAgain => [
            FilledButton(
              onPressed: () => unawaited(flow.sendAgain()),
              child: Text(words.sendAgainButton),
            ),
            TextButton(onPressed: flow.backToHome, child: backToHomeLabel),
          ],
          _ErrorFooter.backToHomeOnly => [
            FilledButton(onPressed: flow.backToHome, child: backToHomeLabel),
          ],
        },
      ),
    );
  }
}

/// Which buttons an Error variant has at the bottom.
enum _ErrorFooter {
  /// "Try again" (a new listening) and "Back to home".
  tryAgain,

  /// "Send again" (the kept clip) and "Back to home".
  sendAgain,

  /// "Back to home" alone: trying again now would not help.
  backToHomeOnly,
}

/// What one Error variant looks like and says.
final class _ErrorWording {
  const _ErrorWording({
    required this.icon,
    required this.iconColour,
    required this.circleColour,
    required this.heading,
    required this.headingRole,
    required this.explanation,
    required this.footer,
  });

  final IconData icon;
  final Color iconColour;
  final Color circleColour;
  final String heading;

  /// An alert for a failure on Look Up's side, a status for the rest.
  final SemanticsRole headingRole;

  final String explanation;
  final _ErrorFooter footer;
}

/// "Details (development only)": the failure's type and description, folded away until asked
/// for. Never built outside a development build with `LOOKUP_SHOW_ERROR_DETAILS`.
class _DevelopmentDetails extends StatefulWidget {
  const _DevelopmentDetails({required this.failure});

  final RecognitionFailure failure;

  @override
  State<_DevelopmentDetails> createState() => _DevelopmentDetailsState();
}

class _DevelopmentDetailsState extends State<_DevelopmentDetails> {
  bool _isOpen = false;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: () => setState(() => _isOpen = !_isOpen),
          icon: Icon(_isOpen ? Icons.expand_less : Icons.expand_more),
          label: Text(AppLocalizations.of(context).developmentOnlyDetails),
        ),
        if (_isOpen)
          Text(
            '${widget.failure.runtimeType}\n${widget.failure}',
            style: tokens.typeStyles.caption.copyWith(
              color: tokens.colours.muted,
              fontFamily: ReferenceCodePanel.monospaceFontFamily,
              fontFamilyFallback: ReferenceCodePanel.monospaceFontFallbacks,
            ),
          ),
      ],
    );
  }
}
