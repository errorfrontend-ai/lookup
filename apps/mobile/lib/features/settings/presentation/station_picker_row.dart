import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/presentation/station_logo.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// One choice of the "My station" picker (P6 design §2.12): a radio, then either a station — its
/// logo or first letter (40 dp), its name (16, 700) and "98.1 FM · Lusaka" (13, muted) — or "No
/// station" with "Look Up will ask each time". At least the token's station-row height (56 dp).
///
/// The whole row is one radio button of the picker's group, read with its label and whether it is
/// chosen; a tap chooses it.
class StationPickerRow extends StatelessWidget {
  /// A station of the list (or the kept station the list no longer has, with [note]).
  const StationPickerRow.station({
    super.key,
    required ListenerStation this.station,
    required this.position,
    required this.isChosen,
    required this.onTap,
    this.note,
  });

  /// "No station": Look Up asks each time.
  const StationPickerRow.noStation({super.key, required this.isChosen, required this.onTap})
    : station = null,
      position = 0,
      note = null;

  /// The station this row offers; null for "No station".
  final ListenerStation? station;

  /// The row's place among the stations, from 0, which picks the letter's fill.
  final int position;

  /// Whether this is "My station" now.
  final bool isChosen;

  final VoidCallback onTap;

  /// A line under the station's own, e.g. "Not in the current list".
  final String? note;

  /// The line under a station's name: "98.1 FM · Lusaka", or "98.1 FM" without a city.
  static String detailOf(ListenerStation station, AppLocalizations words) => switch (station.city) {
    final city? => words.chooserStationFrequencyAndCity(station.frequencyLabel, city),
    null => station.frequencyLabel,
  };

  /// What a screen reader says for a station, e.g. "Station A, 98.1 FM, Lusaka".
  static String spokenLabelOf(ListenerStation station, AppLocalizations words) =>
      switch (station.city) {
        final city? => words.chooserStationSpokenWithCity(
          station.name,
          station.frequencyLabel,
          city,
        ),
        null => words.chooserStationSpoken(station.name, station.frequencyLabel),
      };

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final station = this.station;
    final note = this.note;
    final title = station?.name ?? words.stationPickerNoStation;
    final detail = station == null ? words.stationPickerNoStationDetail : detailOf(station, words);
    final spokenLabel = [
      if (station == null) ...[title, detail] else spokenLabelOf(station, words),
      ?note,
    ].join('\n');
    return Semantics(
      inMutuallyExclusiveGroup: true,
      checked: isChosen,
      label: spokenLabel,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: tokens.sizes.stationListRowHeight),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: spacing.space3, vertical: spacing.space2),
            child: Row(
              children: [
                Icon(
                  isChosen ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  color: isChosen ? colours.accent : colours.muted,
                ),
                SizedBox(width: spacing.space3),
                if (station != null) ...[
                  StationLogo(
                    stationName: station.name,
                    logo: station.logo,
                    fillColour: [colours.ink, colours.muted, colours.accent][position % 3],
                  ),
                  SizedBox(width: spacing.space3),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: typeStyles.body.copyWith(fontWeight: FontWeight.w700)),
                      Text(detail, style: typeStyles.caption.copyWith(color: colours.muted)),
                      if (note != null)
                        Text(note, style: typeStyles.caption.copyWith(color: colours.muted)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
