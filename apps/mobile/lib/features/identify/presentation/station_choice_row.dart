import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/public_image_view.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// One station of "Which station?" (P6 design §2.6; wireframe Chooser; P6-CHOOSER-03, -04): the
/// station's logo or its first letter, its name, "98.1 FM · Lusaka" (just "98.1 FM" without a city)
/// and a chevron, at least 64 dp tall with 12 dp around.
///
/// The whole row is one button, read as "Station A, 98.1 FM, Lusaka"; a tap chooses that station
/// (T44).
class StationChoiceRow extends StatelessWidget {
  const StationChoiceRow({
    super.key,
    required this.candidate,
    required this.position,
    required this.onTap,
  });

  /// The row is at least this tall: the wireframe's 64 dp (the checklist's minimum is 56).
  static const double minimumHeight = 64;

  /// The candidate this row offers, with its station and card.
  final RecognitionResult candidate;

  /// The row's place in the sheet, from 0, which picks the letter's fill: ink, muted, accent.
  final int position;

  final VoidCallback onTap;

  /// What a screen reader says for the row, e.g. "Station A, 98.1 FM, Lusaka".
  static String spokenLabelOf(RecognitionResult candidate, AppLocalizations words) =>
      switch (candidate.stationCity) {
        final city? => words.chooserStationSpokenWithCity(
          candidate.stationName,
          candidate.stationFrequencyLabel,
          city,
        ),
        null => words.chooserStationSpoken(candidate.stationName, candidate.stationFrequencyLabel),
      };

  /// The line under the name: "98.1 FM · Lusaka", or "98.1 FM" without a city.
  static String detailOf(RecognitionResult candidate, AppLocalizations words) =>
      switch (candidate.stationCity) {
        final city? => words.chooserStationFrequencyAndCity(candidate.stationFrequencyLabel, city),
        null => candidate.stationFrequencyLabel,
      };

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    return Semantics(
      button: true,
      label: spokenLabelOf(candidate, words),
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minimumHeight),
          child: Padding(
            padding: EdgeInsets.all(spacing.space3),
            child: Row(
              children: [
                _StationLogo(candidate: candidate, position: position),
                SizedBox(width: spacing.space3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        candidate.stationName,
                        style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        detailOf(candidate, words),
                        style: typeStyles.caption.copyWith(color: colours.muted),
                      ),
                    ],
                  ),
                ),
                SizedBox(width: spacing.space2),
                Icon(Icons.chevron_right, color: colours.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The station's logo, 40 dp with medium corners, or the first letter of its name in the surface
/// colour on ink, muted or accent by the row's place; the letter also shows while a logo loads.
/// Hidden from screen readers: the row's label names the station.
class _StationLogo extends StatelessWidget {
  const _StationLogo({required this.candidate, required this.position});

  final RecognitionResult candidate;
  final int position;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final size = tokens.spacing.space10;
    final logo = candidate.stationLogo;
    final fills = [colours.ink, colours.muted, colours.accent];
    final trimmedName = candidate.stationName.trim();
    final initial = trimmedName.isEmpty ? '' : trimmedName.characters.first.toUpperCase();
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(tokens.radii.medium),
          child: ColoredBox(
            color: fills[position % fills.length],
            child: Stack(
              fit: StackFit.expand,
              children: [
                Center(
                  // The square keeps its size at large text; the letter shrinks to fit it.
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      initial,
                      style: tokens.typeStyles.body.copyWith(
                        color: colours.surface,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                if (logo != null)
                  PublicImageView(
                    image: logo,
                    displaySize: Size.square(size),
                    loadedBackgroundColour: colours.surface,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
