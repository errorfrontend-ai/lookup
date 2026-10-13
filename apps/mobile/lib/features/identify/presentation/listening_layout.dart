import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/level_bars.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The layout Listening and Identifying share (design §2.4, §2.5; wireframe Listening), centred
/// between the header and the footer: the ring, the heading, a line of text, the level bars, the
/// progress bar and the countdown.
///
/// Identifying is "the Listening layout with the ring still", so the ring must stay exactly where
/// it is when Listening becomes Identifying. The column is centred, so everything in it counts:
/// the heading and the line of text each keep the room of the other screen's words there
/// ([headingToFit], [textToFit]), and a screen without level bars or a countdown keeps their rows
/// empty. Both screens also keep the room of Identifying's slow lines (P6 design §2.5), so nothing
/// moves when a send turns slow. What only keeps room is laid out but never drawn, touched or read
/// by a screen reader.
class ListeningLayout extends StatelessWidget {
  const ListeningLayout({
    super.key,
    required this.ring,
    required this.heading,
    required this.headingToFit,
    required this.text,
    required this.textToFit,
    required this.progressTrack,
    this.levelBars,
    this.countdown,
    this.countdownToFit,
    this.isTextAnnounced = false,
  });

  /// The `LevelRing`, live on Listening and still on Identifying.
  final Widget ring;

  /// The screen's heading, announced as a status.
  final String heading;

  /// The other screen's heading, whose room the heading keeps.
  final String headingToFit;

  /// The line under the heading.
  final String text;

  /// The other screen's line, whose room this one keeps.
  final String textToFit;

  /// The bar under the level bars.
  final Widget progressTrack;

  /// The level bars; when null their row is kept empty.
  final Widget? levelBars;

  /// The countdown under the bar ("3 seconds left"), if the screen has one.
  final String? countdown;

  /// Words whose room the countdown row keeps, on a screen without a countdown.
  final String? countdownToFit;

  /// Whether [text] is a polite live region, announced when it changes (Identifying's slow line).
  final bool isTextAnnounced;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final textStyle = typeStyles.body.copyWith(color: colours.muted);
    final countdownStyle = typeStyles.caption.copyWith(
      color: colours.muted,
      fontWeight: FontWeight.w600,
    );
    final countdown = this.countdown;
    final countdownToFit = this.countdownToFit;
    final words = AppLocalizations.of(context);
    Widget roomOf(List<String> lines, TextStyle style) => Stack(
      alignment: Alignment.topCenter,
      children: [for (final line in lines) Text(line, textAlign: TextAlign.center, style: style)],
    );
    final shownText = Text(text, textAlign: TextAlign.center, style: textStyle);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ring,
          // The ring's box already holds its 60 dp halo: 4 dp more makes the wireframe's gap.
          SizedBox(height: spacing.space1),
          _WithRoomFor(
            roomFor: StateHeading(
              headingToFit,
              role: SemanticsRole.status,
              textAlign: TextAlign.center,
            ),
            shown: StateHeading(heading, role: SemanticsRole.status, textAlign: TextAlign.center),
          ),
          SizedBox(height: spacing.space2),
          _WithRoomFor(
            roomFor: roomOf([textToFit, words.identifyingSlow], textStyle),
            shown: isTextAnnounced ? Semantics(liveRegion: true, child: shownText) : shownText,
          ),
          SizedBox(height: spacing.space6),
          levelBars ?? SizedBox(height: LevelBars.rowHeight(spacing)),
          SizedBox(height: spacing.space6),
          ConstrainedBox(
            // 220 dp, or less on a narrower screen.
            constraints: BoxConstraints(maxWidth: spacing.space10 * 5 + spacing.space5),
            child: progressTrack,
          ),
          SizedBox(height: spacing.space2),
          _WithRoomFor(
            roomFor: roomOf([
              ?countdownToFit,
              words.identifyingClipSent,
              words.identifyingClipPercentSent(100),
            ], countdownStyle),
            shown: countdown == null
                ? null
                : Text(countdown, textAlign: TextAlign.center, style: countdownStyle),
          ),
        ],
      ),
    );
  }
}

/// [shown] in a box at least as large as [roomFor] would take: [roomFor] is laid out but hidden
/// from sight, touch and screen readers.
class _WithRoomFor extends StatelessWidget {
  const _WithRoomFor({this.roomFor, this.shown});

  final Widget? roomFor;
  final Widget? shown;

  @override
  Widget build(BuildContext context) {
    final roomFor = this.roomFor;
    return Stack(
      alignment: Alignment.topCenter,
      children: [
        if (roomFor != null)
          Visibility(
            visible: false,
            maintainState: true,
            maintainAnimation: true,
            maintainSize: true,
            child: roomFor,
          ),
        ?shown,
      ],
    );
  }
}
