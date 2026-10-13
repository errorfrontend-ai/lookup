import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/features/history/presentation/day_label_words.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/features/settings/domain/station_list.dart';
import 'package:lookup_listener/features/settings/domain/station_list_reading.dart';
import 'package:lookup_listener/features/settings/presentation/settings_section.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker.dart';
import 'package:lookup_listener/features/settings/presentation/station_picker_row.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The "My station" picker at `/settings/my-station` (P6 design §2.12; no wireframe, gap 4;
/// P6-MYSTATION-01, -02): one of the two places the app lists stations (D8, P6-MYSTATION-06).
///
/// - Back ("Back") and "My station", then what it is for.
/// - "No station" first ("Look Up will ask each time"), which clears "My station"; then exactly the
///   stations `GET /api/v1/stations` gave, in its order, each with a radio. A tap keeps that
///   station and returns to Settings ([onDone]).
/// - "My station" when the list no longer has it: at the top, chosen, with "Not in the current
///   list". The app never clears it by itself (contract §5.8).
/// - A search field, only with more than [searchFromStationCount] stations, filtering on the phone
///   by name, frequency or city (gap 33).
/// - Loading, nothing kept: "Loading stations…"; failed, nothing kept: "Couldn't load the
///   stations." and "Try again"; failed with a list kept: that list under "Couldn't refresh the
///   list. These are the stations saved on Today, 09:12."; an empty list: "No stations are listed in
///   Look Up yet."
///
/// A choice the phone cannot keep goes on to the app's handler for errors nobody caught, which
/// reports it, and the picker stays open.
class MyStationPickerScreen extends ConsumerStatefulWidget {
  const MyStationPickerScreen({super.key, required this.onDone, required this.now});

  /// Back, and after a choice: returns to Settings.
  final VoidCallback onDone;

  /// The clock's time now, which "Today" and "Yesterday" are read against.
  final DateTime Function() now;

  /// The search field shows only above this many stations.
  static const int searchFromStationCount = 10;

  @override
  ConsumerState<MyStationPickerScreen> createState() => _MyStationPickerScreenState();
}

class _MyStationPickerScreenState extends ConsumerState<MyStationPickerScreen> {
  final TextEditingController _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _choose(ListenerStation station) async {
    await ref.read(myStationProvider.notifier).choose(station);
    if (mounted) widget.onDone();
  }

  Future<void> _clear() async {
    await ref.read(myStationProvider.notifier).clear();
    if (mounted) widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final reading = ref.watch(stationPickerProvider);
    return ScreenFrame(
      exitButton: ScreenExitButton.back(label: words.backButton, onPressed: widget.onDone),
      title: Semantics(
        header: true,
        child: Text(
          words.settingsMyStation,
          style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      bodyPadding: EdgeInsets.fromLTRB(
        spacing.space4,
        spacing.space2,
        spacing.space4,
        spacing.space6,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(words.stationPickerLead, style: typeStyles.body.copyWith(color: colours.muted)),
          SizedBox(height: spacing.space4),
          switch (reading) {
            AsyncData(
              value: StationListShown(:final list, :final fetchedAt, :final isRefreshFailed),
            ) =>
              _shownList(list, fetchedAt: fetchedAt, isRefreshFailed: isRefreshFailed),
            AsyncData(value: StationListUnavailable()) || AsyncError() => _LoadFailed(
              onTryAgain: () => unawaited(ref.read(stationPickerProvider.notifier).tryAgain()),
            ),
            AsyncLoading() => const _Loading(),
          },
        ],
      ),
    );
  }

  Widget _shownList(
    StationList list, {
    required DateTime fetchedAt,
    required bool isRefreshFailed,
  }) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final colours = tokens.colours;
    final words = AppLocalizations.of(context);
    final myStation = ref.watch(myStationProvider).value;
    final keptButNotListed = myStation != null && list.stationWithId(myStation.id) == null
        ? myStation
        : null;
    final hasSearch = list.stations.length > MyStationPickerScreen.searchFromStationCount;
    final shownStations = hasSearch ? list.stationsMatching(_search.text) : list.stations;
    final mutedBody = tokens.typeStyles.body.copyWith(color: colours.muted);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (isRefreshFailed) ...[
          Text(
            words.stationPickerRefreshFailed(
              DayLabelWords.dayAndTimeOf(
                DayLabel.of(fetchedAt, now: widget.now()),
                words,
                Localizations.localeOf(context),
              ),
            ),
            style: tokens.typeStyles.body,
          ),
          SizedBox(height: spacing.space4),
        ],
        if (hasSearch) ...[
          TextField(
            controller: _search,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: words.stationPickerSearchLabel,
              hintText: words.stationPickerSearchHint,
              prefixIcon: const Icon(Icons.search),
              border: const OutlineInputBorder(),
            ),
          ),
          SizedBox(height: spacing.space4),
        ],
        SettingsSection(
          rows: [
            StationPickerRow.noStation(
              isChosen: myStation == null,
              onTap: () => unawaited(_clear()),
            ),
            if (keptButNotListed != null)
              StationPickerRow.station(
                station: keptButNotListed,
                position: 0,
                isChosen: true,
                note: words.stationPickerNotListed,
                onTap: () => unawaited(_choose(keptButNotListed)),
              ),
            for (final (position, station) in shownStations.indexed)
              StationPickerRow.station(
                key: ValueKey(station.id),
                station: station,
                position: position,
                isChosen: station.id == myStation?.id,
                onTap: () => unawaited(_choose(station)),
              ),
          ],
        ),
        if (list.stations.isEmpty) ...[
          SizedBox(height: spacing.space4),
          Text(words.stationPickerEmpty, style: mutedBody),
        ],
      ],
    );
  }
}

/// "Loading stations…" with a spinner, while the list is first fetched.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return Row(
      children: [
        SizedBox.square(
          dimension: tokens.spacing.space6,
          child: CircularProgressIndicator(
            strokeWidth: 3,
            color: tokens.colours.accent,
            semanticsLabel: AppLocalizations.of(context).stationPickerLoading,
          ),
        ),
        SizedBox(width: tokens.spacing.space3),
        Expanded(
          child: ExcludeSemantics(
            child: Text(
              AppLocalizations.of(context).stationPickerLoading,
              style: tokens.typeStyles.body,
            ),
          ),
        ),
      ],
    );
  }
}

/// "Couldn't load the stations." and "Try again", when nothing is kept on the phone.
class _LoadFailed extends StatelessWidget {
  const _LoadFailed({required this.onTryAgain});

  final VoidCallback onTryAgain;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final words = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(words.stationPickerLoadFailed, style: tokens.typeStyles.body),
        SizedBox(height: tokens.spacing.space4),
        OutlinedButton(onPressed: onTryAgain, child: Text(words.tryAgainButton)),
      ],
    );
  }
}
