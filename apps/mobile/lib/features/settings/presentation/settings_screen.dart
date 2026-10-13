import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/data_saver_rule.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/features/settings/presentation/settings_row.dart';
import 'package:lookup_listener/features/settings/presentation/settings_section.dart';
import 'package:lookup_listener/features/settings/presentation/settings_switch_row.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The Settings tab at `/settings` (P6 design §2.11; wireframe Settings; P6-SETTINGS-01 to -07):
///
/// - **Listening**: "My station" with the chosen station and frequency, or "Not set", and what it
///   is for — at least [myStationRowMinimumHeight] tall; it opens the picker.
/// - **App**: "Language" and its name (not a control while there is one language), "Privacy" and
///   "About Look Up", each opening its page, and "Clear history" (Q7 as the user answered it on
///   11 October 2026), which asks first and then deletes what History keeps.
///
/// The Data section joins it in piece 4, when its switch works; until then it is absent, never dead.
/// Each page opens through a callback the tab shell gives, which knows the routes. The tab bar is
/// the shell's, with Settings marked as the current tab (P6-NAVIGATION-06).
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({
    super.key,
    required this.onOpenMyStation,
    required this.onOpenPrivacy,
    required this.onOpenAbout,
  });

  /// The "My station" row is at least this tall (P6-SETTINGS-04).
  static const double myStationRowMinimumHeight = 64;

  final VoidCallback onOpenMyStation;
  final VoidCallback onOpenPrivacy;
  final VoidCallback onOpenAbout;

  /// The line under "My station": the station and frequency, or "Not set", then what it is for;
  /// null while it is first read.
  static String? myStationDetailOf(
    AsyncValue<ListenerStation?> myStation,
    AppLocalizations words,
  ) => switch (myStation) {
    AsyncData(value: final station?) => words.settingsMyStationChosen(
      station.name,
      station.frequencyLabel,
    ),
    AsyncData() || AsyncError() => words.settingsMyStationNotSet,
    AsyncLoading() => null,
  };

  /// [bytes] in the Data section's words: "86 KB", "1.2 MB" (P6 design §2.11).
  static String dataAmountOf(int bytes, AppLocalizations words) => switch (DataAmount.of(bytes)) {
    DataAmountInKilobytes(:final kilobytes) => words.dataAmountKilobytes(kilobytes),
    DataAmountInMegabytes(:final megabytes) => words.dataAmountMegabytes(megabytes),
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    return ScreenFrame(
      title: Semantics(
        header: true,
        child: Text(words.settingsHeading, style: tokens.typeStyles.title),
      ),
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space4,
        spacing.space5,
        spacing.space4,
        spacing.space6,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsSection(
            heading: words.settingsListeningHeading,
            rows: [
              SettingsRow(
                title: words.settingsMyStation,
                detail: myStationDetailOf(ref.watch(myStationProvider), words),
                onTap: onOpenMyStation,
                showsChevron: true,
                minimumHeight: myStationRowMinimumHeight,
              ),
            ],
          ),
          SizedBox(height: spacing.space6),
          SettingsSection(
            heading: words.settingsDataHeading,
            rows: [
              SettingsRow(
                title: words.settingsEachIdentifyUses,
                detail: words.settingsEachIdentifyUsesAmount,
              ),
              SettingsRow(
                title: words.settingsUsedThisMonth,
                detail: switch (ref.watch(bytesUsedThisMonthProvider)) {
                  AsyncData(:final value) => dataAmountOf(value, words),
                  _ => null,
                },
              ),
              SettingsSwitchRow(
                title: words.settingsLoadPictures,
                note: words.settingsLoadPicturesNote,
                isOn: ref.watch(loadsPicturesOnMobileDataProvider).value,
                onChanged: (isOn) =>
                    unawaited(ref.read(loadsPicturesOnMobileDataProvider.notifier).set(isOn)),
              ),
            ],
          ),
          SizedBox(height: spacing.space6),
          SettingsSection(
            heading: words.settingsAppHeading,
            rows: [
              SettingsRow(title: words.settingsLanguage, detail: words.settingsLanguageName),
              SettingsRow(title: words.settingsPrivacy, onTap: onOpenPrivacy, showsChevron: true),
              SettingsRow(title: words.settingsAbout, onTap: onOpenAbout, showsChevron: true),
              SettingsRow(
                title: words.settingsClearHistory,
                isDanger: true,
                onTap: () => unawaited(_clearHistory(context, ref)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// "Clear history": asks first; "Clear" deletes what History keeps and confirms with "History
  /// cleared". A clear that fails goes on to the app's handler for errors nobody caught, which
  /// reports it, and nothing is confirmed.
  Future<void> _clearHistory(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final tokens = context.lookUpTokens;
    final words = AppLocalizations.of(context);
    final animationStyle = MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : AnimationStyle(duration: tokens.motion.base, reverseDuration: tokens.motion.base);
    final isConfirmed = await showDialog<bool>(
      context: context,
      animationStyle: animationStyle,
      builder: (context) => const _ClearHistoryQuestion(),
    );
    if (isConfirmed != true || !context.mounted) return;
    await ref.read(historyRepositoryProvider).clear();
    messenger.showSnackBar(
      SnackBar(content: Text(words.historyClearedConfirmation)),
      // In and out over motion.base (S4-ACCESSIBILITY-04); no slide when the phone asks for less
      // motion ("Remove animations").
      snackBarAnimationStyle: animationStyle,
    );
  }
}

/// "Clear history?" with what it deletes, "Cancel" and "Clear" in the danger colour.
class _ClearHistoryQuestion extends StatelessWidget {
  const _ClearHistoryQuestion();

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final words = AppLocalizations.of(context);
    return AlertDialog(
      backgroundColor: colours.surface,
      title: Text(words.clearHistoryQuestion, style: tokens.typeStyles.heading),
      content: Text(
        words.clearHistoryExplanation,
        style: tokens.typeStyles.body.copyWith(color: colours.muted),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(words.cancelButton),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: TextButton.styleFrom(foregroundColor: colours.danger),
          child: Text(words.clearButton),
        ),
      ],
    );
  }
}
