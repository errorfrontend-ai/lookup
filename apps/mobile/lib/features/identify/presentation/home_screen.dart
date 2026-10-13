import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/identify/presentation/how_it_works_note.dart';
import 'package:lookup_listener/features/identify/presentation/how_it_works_note_card.dart';
import 'package:lookup_listener/features/identify/presentation/identify_button.dart';
import 'package:lookup_listener/features/identify/presentation/my_station_chip.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/send_test_error_button.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Home, the `idle` state at `/` and the Identify tab (design §2.2; P6 design §2.3; wireframe
/// Main): "Look Up" with the "My station" chip at the top, and at the bottom, in the thumb zone, the
/// question, how it works, the big "Tap to identify" control and what one identify costs.
///
/// - **The chip** (P6-NAVIGATION-03, -04) names "My station" and opens Settings ([onOpenSettings],
///   given by the tab shell, which knows the routes). It shares the header with "Look Up", kept
///   within half of it; when both no longer fit on one line (large text), it moves under the title.
/// - **The first-open note** "How Look Up works" (ALL-USABILITY-04, P6-D40) sits under the header
///   on the first launch only, while the identify control stays at the bottom. The Step 4
///   instruction line stays as it is.
/// - The tap goes to the flow, which records at once when the microphone is allowed and otherwise
///   shows the Permission screen; a second tap while an identify is under way is ignored there
///   (T41).
///
/// Home has no Back of its own: system Back leaves the app, as on any first screen; the tab bar
/// below it is the shell's.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key, required this.onOpenSettings});

  /// The chip's tap: opens the Settings tab.
  final VoidCallback onOpenSettings;

  /// What one identify costs: the clip's length from the clip settings (S4-LISTENING-03), and the
  /// size of the upload it makes (S4-D31).
  static String dataNoteOf(AppLocalizations words) =>
      words.homeDataNote(RecognitionFlow.clipSettings.clipDurationSeconds);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final showsDeveloperTools = ref.watch(appConfigurationProvider).showsDeveloperTools;
    final showsHowItWorks = ref.watch(howItWorksNoteProvider);
    final mutedBody = typeStyles.body.copyWith(color: colours.muted);
    return ScreenFrame(
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _HomeHeader(onOpenSettings: onOpenSettings),
          if (showsDeveloperTools)
            const Align(alignment: AlignmentDirectional.centerEnd, child: SendTestErrorButton()),
        ],
      ),
      isBodyAtBottom: true,
      // With the note, 12 dp above and below it instead of 24, so it never pushes "Tap to
      // identify" off a 320 × 640 screen at text scale 1.0 (P6 design §2.3).
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space6,
        showsHowItWorks ? spacing.space3 : spacing.space6,
        spacing.space6,
        spacing.space12,
      ),
      bodyTop: showsHowItWorks
          ? Padding(
              padding: EdgeInsets.only(bottom: spacing.space3),
              child: const HowItWorksNoteCard(),
            )
          : null,
      body: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Semantics(
            header: true,
            child: Text(words.homeHeading, textAlign: TextAlign.center, style: typeStyles.display),
          ),
          SizedBox(height: spacing.space2),
          Text(words.homeInstruction, textAlign: TextAlign.center, style: mutedBody),
          // 32 dp to the disc; its halo takes 28 of them, as the wireframe draws it.
          SizedBox(height: spacing.space8),
          IdentifyButton(
            onPressed: () => unawaited(ref.read(recognitionFlowProvider.notifier).identify()),
          ),
          SizedBox(height: spacing.space8 + spacing.space3),
          Text(
            dataNoteOf(words),
            textAlign: TextAlign.center,
            style: typeStyles.caption.copyWith(color: colours.muted),
          ),
        ],
      ),
    );
  }
}

/// "Look Up" and the chip (P6 design §2.3, "long names and large text"):
///
/// - side by side while the title and at least half the header fit on one line: the chip takes the
///   room the title leaves, at least half the header, and a name longer than that is cut with "…"
///   (the whole label is read out);
/// - otherwise, at large text sizes, the chip moves under "Look Up", on a line of its own, where its
///   words wrap rather than being cut.
///
/// Whether they fit is measured from the words themselves at the phone's text size, never with a
/// `LayoutBuilder`, which the frame's scrolling cannot measure (`ScreenFrame`). The row keeps the
/// chip's height while "My station" is first read, so nothing moves when the chip appears.
class _HomeHeader extends ConsumerWidget {
  const _HomeHeader({required this.onOpenSettings});

  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final chipLabel =
        MyStationChip.labelOf(ref.watch(myStationProvider), words) ?? words.homeMyStationChipNotSet;
    // The header's width: the window less the safe area and the frame's 20 dp at each side.
    final headerWidth =
        MediaQuery.sizeOf(context).width -
        MediaQuery.paddingOf(context).horizontal -
        2 * spacing.space5;
    final halfHeader = headerWidth / 2;
    final roomBesideTitle =
        headerWidth - _widthOf(context, words.appTitle, tokens.typeStyles.title) - spacing.space3;
    final chipWidth = MyStationChip.naturalWidthOf(context, chipLabel);
    final fitsBeside = (chipWidth < halfHeader ? chipWidth : halfHeader) <= roomBesideTitle;
    final title = Text(words.appTitle, style: tokens.typeStyles.title);
    final chipRowHeight = BoxConstraints(minHeight: tokens.sizes.touchTargetMinimum);
    if (fitsBeside) {
      return ConstrainedBox(
        constraints: chipRowHeight,
        child: Row(
          children: [
            Expanded(child: title),
            SizedBox(width: spacing.space3),
            MyStationChip(onPressed: onOpenSettings, maximumWidth: roomBesideTitle),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        title,
        SizedBox(height: spacing.space2),
        ConstrainedBox(
          constraints: chipRowHeight,
          child: MyStationChip(
            onPressed: onOpenSettings,
            maximumWidth: headerWidth,
            isOnItsOwnLine: true,
          ),
        ),
      ],
    );
  }

  /// How wide [text] is on one line in [style], at the phone's text size.
  static double _widthOf(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: DefaultTextStyle.of(context).style.merge(style)),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }
}
