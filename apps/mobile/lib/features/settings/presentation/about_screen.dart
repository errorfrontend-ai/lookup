import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/configuration/app_version.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/support_chat_button.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// About Look Up at `/settings/about` (P6 design §2.13, Q9 as the user answered it on 11 October
/// 2026; P6-SETTINGS-07): Back ("Back") and "About Look Up", then "Look Up", the version the app
/// reports to the API ("Version 0.1.0 (build 1)", from `AppVersion.current`), what the app does,
/// and "Message support on WhatsApp" when the build has the support number (the S4-D32 rule).
class AboutScreen extends ConsumerWidget {
  const AboutScreen({super.key, required this.onBack});

  /// Returns to Settings.
  final VoidCallback onBack;

  /// "Version 0.1.0 (build 1)" for [appVersion] as pubspec.yaml writes it, `0.1.0+1`.
  static String versionLineOf(AppLocalizations words, {String appVersion = AppVersion.current}) {
    final parts = appVersion.split('+');
    return words.aboutVersion(parts.first, parts.length > 1 ? parts.last : '0');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final supportWhatsAppNumber = ref.watch(appConfigurationProvider).supportWhatsAppNumber;
    return ScreenFrame(
      exitButton: ScreenExitButton.back(label: words.backButton, onPressed: onBack),
      title: Semantics(
        header: true,
        child: Text(
          words.settingsAbout,
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
          Text(words.appTitle, style: typeStyles.title),
          SizedBox(height: spacing.space1),
          Text(versionLineOf(words), style: typeStyles.body.copyWith(color: colours.muted)),
          SizedBox(height: spacing.space5),
          Text(words.aboutDescription, style: typeStyles.body),
          if (supportWhatsAppNumber != null) ...[
            SizedBox(height: spacing.space5),
            SupportChatButton(supportWhatsAppNumber: supportWhatsAppNumber, referenceCode: null),
          ],
        ],
      ),
    );
  }
}
