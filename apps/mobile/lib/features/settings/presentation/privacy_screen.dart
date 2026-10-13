import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Privacy at `/settings/privacy` (P6 design §2.13, Q9 as the user answered it on 11 October 2026;
/// P6-SETTINGS-06): the interim summary until the full privacy notice of Phase 8 (O15). Back
/// ("Back") and "Privacy", then each point after a tick, which screen readers skip, and a line
/// saying it is a short summary.
///
/// Only what is true of this version is said. The point on clips kept with no signal joins when
/// offline capture makes it true (piece 3), and the point on reports when "Report this" exists
/// (piece 4).
class PrivacyScreen extends StatelessWidget {
  const PrivacyScreen({super.key, required this.onBack});

  /// Returns to Settings.
  final VoidCallback onBack;

  /// The points, in order.
  static List<String> pointsOf(AppLocalizations words) => [
    words.privacyListensOnlyWhenYouTap(ClipSettings.standard.clipDurationSeconds),
    words.privacyClipNotKept,
    words.permissionPromiseNeverWhoYouAre,
    words.privacyHistoryStaysOnPhone,
  ];

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    return ScreenFrame(
      exitButton: ScreenExitButton.back(label: words.backButton, onPressed: onBack),
      title: Semantics(
        header: true,
        child: Text(
          words.settingsPrivacy,
          style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space6,
        spacing.space4,
        spacing.space6,
        spacing.space6,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (index, point) in pointsOf(words).indexed) ...[
            if (index > 0) SizedBox(height: spacing.space4),
            _Point(text: point),
          ],
          SizedBox(height: spacing.space6),
          Text(
            words.privacySummaryNote,
            style: typeStyles.caption.copyWith(color: tokens.colours.muted),
          ),
        ],
      ),
    );
  }
}

/// One point after a green tick; the tick is decoration, so only the words are read.
class _Point extends StatelessWidget {
  const _Point({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: Icon(Icons.check, size: spacing.space5, color: tokens.colours.success),
        ),
        SizedBox(width: spacing.space3),
        Expanded(child: Text(text, style: tokens.typeStyles.body)),
      ],
    );
  }
}
