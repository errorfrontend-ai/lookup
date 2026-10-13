import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/station_choice_row.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// "Which station?", the `chooseStation` state at `/choose-station` (P6 design §2.6, P6-D9;
/// wireframe Chooser): the ad is on more than one station, and the listener picks theirs.
///
/// - **Behind**: Identifying as it stood, still, under a scrim of the ink colour at 55%. It is
///   hidden from screen readers (the scrim blocks the semantics behind it), and a tap on the scrim
///   does nothing, so a stray tap never throws an identify away (P6-CHOOSER-11).
/// - **The sheet**: Material's `BottomSheet` on the surface colour, top corners radius xl, at most
///   640 dp wide and 90% of the screen's height, scrolling inside. Its semantics scope a route and
///   are named by the title (P6-ACCESSIBILITY-07). A handle at the top centre, hidden from screen
///   readers (P6-CHOOSER-12); the title; one sentence (P6-CHOOSER-13, P6-D42); one row per
///   candidate, 2 to 4, in the answer's order (P6-CHOOSER-02); "Remember my station — skip this
///   next time", ticked when the sheet opens, toggled by its whole row (P6-CHOOSER-05, -06); and
///   "Cancel".
/// - **A row** shows that station's Result at once, from the card already received (T44,
///   P6-CHOOSER-09); the tick is read at that moment and passed to the flow.
/// - **Cancel**, dragging the sheet down, a downward fling and system Back go Home with nothing
///   queued (T46, P6-CHOOSER-14).
///
/// The sheet slides up over motion.base, and is simply there when the phone asks for less motion.
class ChooseStationScreen extends ConsumerStatefulWidget {
  const ChooseStationScreen({super.key, required this.state});

  final ChooseStationState state;

  /// The sheet is never wider than this, and is centred on a wider screen.
  static const double sheetMaximumWidth = 640;

  /// The sheet takes at most this share of the screen's height and scrolls inside.
  static const double sheetMaximumHeightFraction = 0.9;

  /// The scrim: the ink colour at 55%, the wireframe's `rgba(28, 25, 23, 0.55)`.
  static const double scrimOpacity = 0.55;

  /// The handle: 40 × 4 dp with 2 dp corners.
  static const Size handleSize = Size(40, 4);

  @override
  ConsumerState<ChooseStationScreen> createState() => _ChooseStationScreenState();
}

class _ChooseStationScreenState extends ConsumerState<ChooseStationScreen>
    with SingleTickerProviderStateMixin {
  /// Where the sheet is: 0 below the screen, 1 fully up. `BottomSheet` moves it while dragged.
  late final AnimationController _sheetPosition = AnimationController(vsync: this);

  /// "Remember my station": ticked when the sheet opens (P6-CHOOSER-05). The sheet's own state,
  /// read when a row is tapped (P6 design §3.4).
  bool _isRemembered = true;

  /// Set once the listener chose or cancelled, so a second tap while the screen leaves does nothing.
  bool _hasAnswered = false;

  bool _hasEntered = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sheetPosition.duration = context.lookUpTokens.motion.base;
    if (_hasEntered) return;
    _hasEntered = true;
    if (MediaQuery.disableAnimationsOf(context)) {
      _sheetPosition.value = 1;
    } else {
      _sheetPosition.forward();
    }
  }

  @override
  void dispose() {
    _sheetPosition.dispose();
    super.dispose();
  }

  void _choose(String stationId) {
    if (_hasAnswered) return;
    _hasAnswered = true;
    ref
        .read(recognitionFlowProvider.notifier)
        .chooseStation(stationId: stationId, isRemembered: _isRemembered);
  }

  void _cancel() {
    if (_hasAnswered) return;
    _hasAnswered = true;
    ref.read(recognitionFlowProvider.notifier).backToHome();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final screenHeight = MediaQuery.sizeOf(context).height;
    return PopScope<Object?>(
      // System Back is Cancel (T46).
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _cancel();
      },
      child: Scaffold(
        body: Stack(
          fit: StackFit.expand,
          children: [
            // Identifying as it stood, still: no ticker runs, no tap reaches it, no screen reader
            // reads it.
            const ExcludeSemantics(
              child: IgnorePointer(child: TickerMode(enabled: false, child: IdentifyingScreen())),
            ),
            // The scrim. It blocks the semantics of everything drawn before it, and absorbs every
            // tap, which does nothing.
            BlockSemantics(
              child: AbsorbPointer(
                child: ColoredBox(
                  color: colours.ink.withValues(alpha: ChooseStationScreen.scrimOpacity),
                  child: const SizedBox.expand(),
                ),
              ),
            ),
            Align(
              alignment: Alignment.bottomCenter,
              child: ListenableBuilder(
                listenable: _sheetPosition,
                builder: (context, sheet) => FractionalTranslation(
                  translation: Offset(0, 1 - _sheetPosition.value),
                  child: sheet,
                ),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: ChooseStationScreen.sheetMaximumWidth,
                    maxHeight: screenHeight * ChooseStationScreen.sheetMaximumHeightFraction,
                  ),
                  child: BottomSheet(
                    animationController: _sheetPosition,
                    onClosing: _cancel,
                    showDragHandle: false,
                    backgroundColor: colours.surface,
                    elevation: 0,
                    clipBehavior: Clip.antiAlias,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.vertical(
                        top: Radius.circular(tokens.radii.extraLarge),
                      ),
                    ),
                    builder: (context) => _SheetContent(
                      state: widget.state,
                      isRemembered: _isRemembered,
                      onRememberChanged: (isRemembered) =>
                          setState(() => _isRemembered = isRemembered),
                      onChoose: _choose,
                      onCancel: _cancel,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What the sheet holds, inside the semantics of a route named by its title.
class _SheetContent extends StatelessWidget {
  const _SheetContent({
    required this.state,
    required this.isRemembered,
    required this.onRememberChanged,
    required this.onChoose,
    required this.onCancel,
  });

  final ChooseStationState state;
  final bool isRemembered;
  final ValueChanged<bool> onRememberChanged;
  final ValueChanged<String> onChoose;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final groupShape = BorderRadius.circular(tokens.radii.large);
    return Semantics(
      scopesRoute: true,
      namesRoute: true,
      explicitChildNodes: true,
      label: words.chooserTitle,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.only(top: spacing.space2),
              child: ExcludeSemantics(
                child: Center(
                  child: Container(
                    width: ChooseStationScreen.handleSize.width,
                    height: ChooseStationScreen.handleSize.height,
                    decoration: BoxDecoration(
                      color: colours.line,
                      borderRadius: BorderRadius.circular(
                        ChooseStationScreen.handleSize.height / 2,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(
                  spacing.space4,
                  spacing.space3,
                  spacing.space4,
                  spacing.space6,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(words.chooserTitle, style: typeStyles.cardTitle),
                    ),
                    SizedBox(height: spacing.space2),
                    Text(
                      state.areAllCandidatesDefaultCards
                          ? words.chooserPlayedOnSeveralStations
                          : words.chooserOnSeveralStationsNow,
                      style: typeStyles.body.copyWith(color: colours.muted),
                    ),
                    SizedBox(height: spacing.space3),
                    DecoratedBox(
                      position: DecorationPosition.foreground,
                      decoration: BoxDecoration(
                        border: Border.all(color: colours.lineSoft),
                        borderRadius: groupShape,
                      ),
                      child: ClipRRect(
                        borderRadius: groupShape,
                        child: Material(
                          type: MaterialType.transparency,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (final (position, candidate) in state.candidates.indexed) ...[
                                if (position > 0)
                                  Divider(height: 1, thickness: 1, color: colours.lineSoft),
                                StationChoiceRow(
                                  candidate: candidate,
                                  position: position,
                                  onTap: () => onChoose(candidate.stationId),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                    SizedBox(height: spacing.space3),
                    CheckboxListTile(
                      value: isRemembered,
                      onChanged: (isTicked) => onRememberChanged(isTicked ?? false),
                      title: Text(words.chooserRememberMyStation, style: typeStyles.body),
                      controlAffinity: ListTileControlAffinity.leading,
                      contentPadding: EdgeInsets.zero,
                      minTileHeight: tokens.sizes.touchTargetMinimum,
                      activeColor: colours.accent,
                      checkColor: colours.onAccent,
                    ),
                    SizedBox(height: spacing.space3),
                    TextButton(
                      onPressed: onCancel,
                      style: TextButton.styleFrom(
                        foregroundColor: colours.ink,
                        textStyle: typeStyles.body.copyWith(fontWeight: FontWeight.w600),
                      ),
                      child: Text(words.cancelButton),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
