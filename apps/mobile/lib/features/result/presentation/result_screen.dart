import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter/services.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/action_button_list.dart';
import 'package:lookup_listener/features/result/presentation/action_registry.dart';
import 'package:lookup_listener/features/result/presentation/banner_box.dart';
import 'package:lookup_listener/features/result/presentation/client_logo.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The Result screen (design §2.6 and §2.7; wireframes Result and Result320): "Found it", then a
/// card with the banner (only when there is one), the advertiser and the station that played the
/// ad, the ad's title as the main heading and any notes, then the station's buttons.
///
/// It shows the campaign's own card and the advertiser's default card alike; the default card adds
/// one note under the title (S4-D21). Below 360 dp wide it takes Result320's tighter spacing,
/// smaller logo and title, and drops the button icons (S4-D20). The whole screen scrolls when the
/// text is large.
///
/// It knows nothing of the recognition flow: it is given the result and what Back does.
class ResultScreen extends StatefulWidget {
  const ResultScreen({
    super.key,
    required this.result,
    required this.onBackToHome,
    this.actionRegistry = ActionRegistry.standard,
  });

  /// Below this width, in logical pixels, the screen takes Result320's compact layout. The tokens
  /// have no breakpoint, so the line is the width of the wireframes' standard board.
  static const double compactLayoutBelowWidth = 360;

  final RecognitionResult result;

  /// The Back arrow and the system Back gesture both lead Home (T35).
  final VoidCallback onBackToHome;

  final ActionRegistry actionRegistry;

  @override
  State<ResultScreen> createState() => _ResultScreenState();
}

class _ResultScreenState extends State<ResultScreen> {
  @override
  void initState() {
    super.initState();
    // One haptic tick as the result appears (S4-LISTENING-14), for the campaign's card and the
    // advertiser's default card alike (S4-D21).
    unawaited(HapticFeedback.selectionClick());
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final mediaQueryWidth = MediaQuery.sizeOf(context).width;
    final isCompact = mediaQueryWidth < ResultScreen.compactLayoutBelowWidth;
    // 16 dp at the sides and between the card and the buttons; 12 dp at 320 dp (Result320).
    final sideSpace = isCompact ? spacing.space3 : spacing.space4;
    final cardWidth = mediaQueryWidth - MediaQuery.paddingOf(context).horizontal - 2 * sideSpace;
    return PopScope(
      // System Back does what the Back arrow does (design §2.1).
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onBackToHome();
      },
      child: ScreenFrame(
        exitButton: ScreenExitButton.back(
          label: AppLocalizations.of(context).backToHomeButton,
          onPressed: widget.onBackToHome,
        ),
        title: const _FoundItHeading(),
        bodyPadding: EdgeInsets.fromLTRB(
          sideSpace,
          isCompact ? spacing.space1 : spacing.space2,
          sideSpace,
          spacing.space6,
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _ResultCard(
              result: widget.result,
              cardWidth: cardWidth,
              isCompact: isCompact,
              hasUsableButton: widget.result.card.shownActions.any(
                (action) => widget.actionRegistry.registrationFor(action) != null,
              ),
            ),
            SizedBox(height: sideSpace),
            ActionButtonList(
              card: widget.result.card,
              showsIcons: !isCompact,
              registry: widget.actionRegistry,
            ),
          ],
        ),
      ),
    );
  }
}

/// "Found it" beside the Back arrow: read as a heading and announced as soon as the screen appears,
/// as the state screens' headings are (design §2.6), because the result arrives without the
/// listener touching anything.
///
/// Two semantics nodes, as in the identify screens' `StateHeading`: Flutter refuses a node that is
/// both a live region and a status, so the outer node carries the status role and the inner one is
/// the heading and the live region that Android's TalkBack announces.
class _FoundItHeading extends StatelessWidget {
  const _FoundItHeading();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      role: SemanticsRole.status,
      child: Semantics(
        container: true,
        header: true,
        liveRegion: true,
        child: Text(
          AppLocalizations.of(context).resultFoundIt,
          style: context.lookUpTokens.typeStyles.body.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

/// The white card: banner, client row, title and notes.
class _ResultCard extends StatelessWidget {
  const _ResultCard({
    required this.result,
    required this.cardWidth,
    required this.isCompact,
    required this.hasUsableButton,
  });

  final RecognitionResult result;
  final double cardWidth;
  final bool isCompact;
  final bool hasUsableButton;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final cardShape = BorderRadius.circular(tokens.radii.large);
    // The wireframes' 10 dp gaps fall between two tokens: 12 dp here, 8 dp at 320 dp, where
    // Result320 draws 8.
    final innerGap = isCompact ? spacing.space2 : spacing.space3;
    final noteStyle = typeStyles.body.copyWith(color: colours.muted);
    final headerImage = result.headerImage;
    final words = AppLocalizations.of(context);
    final notes = [
      if (result.kind == RecognitionResultKind.clientDefault)
        words.resultClientDefaultNote(result.clientName),
      ..._cardNotes(result.card, words),
    ];
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: colours.surface, borderRadius: cardShape),
      // Drawn over the banner, so the border stays visible along the image's edges.
      foregroundDecoration: BoxDecoration(
        border: Border.all(color: colours.lineSoft),
        borderRadius: cardShape,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (headerImage != null) BannerBox(image: headerImage, width: cardWidth),
          Padding(
            padding: EdgeInsets.all(isCompact ? spacing.space3 : spacing.space4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _ClientRow(result: result, isCompact: isCompact, gap: innerGap),
                SizedBox(height: innerGap),
                Semantics(
                  header: true,
                  child: Text(
                    result.title,
                    style: isCompact ? typeStyles.cardTitleCompact : typeStyles.cardTitle,
                  ),
                ),
                for (final note in notes) ...[
                  SizedBox(height: innerGap),
                  Text(note, style: noteStyle),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Statements, never instructions: there is no update control before a store listing exists
  /// (S4-USABILITY-02, S4-D21).
  List<String> _cardNotes(ReadActionCard card, AppLocalizations words) {
    if (card.showsUpdateAppHint) return [words.resultUpdateAppHint];
    if (!hasUsableButton) return [words.resultNoButtons];
    return const [];
  }
}

/// The advertiser's logo and name, and "via [station] · [frequency]" under the name.
class _ClientRow extends StatelessWidget {
  const _ClientRow({required this.result, required this.isCompact, required this.gap});

  final RecognitionResult result;
  final bool isCompact;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    return Row(
      children: [
        ClientLogo(
          clientName: result.clientName,
          logo: result.clientLogo,
          // 40 dp, or 36 dp at 320 dp: 36 has no token of its own, so it is built from two.
          diameter: isCompact ? spacing.space8 + spacing.space1 : spacing.space10,
        ),
        SizedBox(width: gap),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(result.clientName, style: typeStyles.body.copyWith(fontWeight: FontWeight.w700)),
              Text(
                AppLocalizations.of(
                  context,
                ).resultViaStation(result.stationName, result.stationFrequencyLabel),
                style: typeStyles.caption.copyWith(color: tokens.colours.muted),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
