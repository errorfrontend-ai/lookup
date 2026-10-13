import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/settings/data/settings_providers.dart';
import 'package:lookup_listener/features/settings/domain/listener_station.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The "My station" chip at the top right of Home (P6 design §2.3; wireframe Main, header;
/// P6-NAVIGATION-03, -04): a radio icon and "My station: Station A", or "My station: Not set"
/// before one is chosen (Q8 as the user answered it on 11 October 2026). A tap opens Settings.
///
/// White fill, a line border and pill corners, at least 48 dp tall (the wireframe's 44 px raised,
/// conflict 11). Beside the title a long name is cut with "…" to keep the chip within
/// [maximumWidth]; on a line of its own ([isOnItsOwnLine], at large text sizes) its words wrap
/// instead, so nothing is cut at text scale 2.0. Screen readers hear the whole label and "Opens
/// Settings". While "My station" is first read, the chip is not drawn, and its row keeps its
/// height, so nothing moves when it appears.
class MyStationChip extends ConsumerWidget {
  const MyStationChip({
    super.key,
    required this.onPressed,
    required this.maximumWidth,
    this.isOnItsOwnLine = false,
  });

  /// Opens the Settings tab.
  final VoidCallback onPressed;

  /// The widest the chip may be.
  final double maximumWidth;

  /// Whether the chip has a line of its own under the title, where its words may wrap.
  final bool isOnItsOwnLine;

  /// The chip's words for [myStation]: the station's name, or "Not set" when none is set or it
  /// cannot be read (then the app sends no hint either); null while it is first read.
  static String? labelOf(AsyncValue<ListenerStation?> myStation, AppLocalizations words) =>
      switch (myStation) {
        AsyncData(value: final station?) => words.homeMyStationChip(station.name),
        AsyncData() || AsyncError() => words.homeMyStationChipNotSet,
        AsyncLoading() => null,
      };

  /// How wide the chip is with [label] when nothing cuts it: its sides, the icon and the gap, the
  /// words at the phone's text size, and the border.
  static double naturalWidthOf(BuildContext context, String label) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final painter = TextPainter(
      text: TextSpan(
        text: label,
        style: DefaultTextStyle.of(context).style.merge(_labelStyle(tokens)),
      ),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final labelWidth = painter.width;
    painter.dispose();
    return 2 * spacing.space3 + spacing.space4 + spacing.space2 + labelWidth + 2;
  }

  static TextStyle _labelStyle(LookUpTokens tokens) =>
      tokens.typeStyles.caption.copyWith(color: tokens.colours.ink, fontWeight: FontWeight.w600);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final label = labelOf(ref.watch(myStationProvider), words);
    if (label == null) return const SizedBox.shrink();
    final shape = StadiumBorder(side: BorderSide(color: colours.line));
    return Semantics(
      button: true,
      label: label,
      hint: words.homeMyStationChipHint,
      excludeSemantics: true,
      onTap: onPressed,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maximumWidth),
        child: Material(
          color: colours.surface,
          shape: shape,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            customBorder: shape,
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: tokens.sizes.touchTargetMinimum),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: spacing.space3),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.radio, size: spacing.space4, color: colours.ink),
                    SizedBox(width: spacing.space2),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: isOnItsOwnLine ? null : 1,
                        overflow: isOnItsOwnLine ? null : TextOverflow.ellipsis,
                        style: _labelStyle(tokens),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
