import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/history/domain/day_label.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/history/presentation/day_label_words.dart';
import 'package:lookup_listener/features/result/presentation/client_logo.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// One saved result in History (P6 design §2.9; wireframe History, section 2; P6-HISTORY-08, -10,
/// -11): the client's logo or first letter in a 40 dp circle (ink, muted or accent by the row's
/// place), "Brand A — Summer service offer", "via Station A · Today, 09:12" and a chevron, in a white
/// card with a line-soft border, at least [minimumHeight] tall.
///
/// The whole row is one button, read as its two lines; a tap opens the saved result.
class HistoryEntryRow extends StatelessWidget {
  const HistoryEntryRow({
    super.key,
    required this.entry,
    required this.position,
    required this.now,
    required this.onTap,
  });

  /// Each row is at least this tall (P6-HISTORY-10).
  static const double minimumHeight = 72;

  final HistoryResultEntry entry;

  /// The row's place in the list, from 0, which picks the letter's fill.
  final int position;

  /// The time "Today" and "Yesterday" are read against.
  final DateTime now;

  /// Opens the saved result.
  final VoidCallback onTap;

  /// The row's two lines: "Brand A — Summer service offer" and "via Station A · Today, 09:12".
  static ({String title, String detail}) linesOf(
    HistoryResultEntry entry, {
    required DateTime now,
    required AppLocalizations words,
    required Locale locale,
  }) {
    final result = entry.result;
    final label = DayLabel.of(entry.capturedAtOnPhone, now: now);
    return (
      title: words.historyResultTitle(result.clientName, result.title),
      detail: words.historyResultDetail(
        result.stationName,
        DayLabelWords.dayAndTimeOf(label, words, locale),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final lines = linesOf(
      entry,
      now: now,
      words: AppLocalizations.of(context),
      locale: Localizations.localeOf(context),
    );
    final fills = [colours.ink, colours.muted, colours.accent];
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(tokens.radii.large),
      side: BorderSide(color: colours.lineSoft),
    );
    return Semantics(
      button: true,
      label: '${lines.title}\n${lines.detail}',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: colours.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          customBorder: shape,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minimumHeight),
            child: Padding(
              padding: EdgeInsets.all(spacing.space3),
              child: Row(
                children: [
                  ClientLogo(
                    clientName: entry.result.clientName,
                    logo: entry.result.clientLogo,
                    diameter: spacing.space10,
                    fillColour: fills[position % fills.length],
                  ),
                  SizedBox(width: spacing.space3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          lines.title,
                          style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
                        ),
                        Text(
                          lines.detail,
                          style: typeStyles.caption.copyWith(color: colours.muted),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(width: spacing.space2),
                  ExcludeSemantics(child: Icon(Icons.chevron_right, color: colours.muted)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
