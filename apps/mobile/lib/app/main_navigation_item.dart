import 'package:flutter/material.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// One destination of the tab bar or the rail (P6 design §2.2): the tab's icon above its label.
///
/// The current tab is marked three ways, never by colour alone (gap 36; P6-ACCESSIBILITY-04, -06):
/// the accent colour, a bold label, and an accent-soft pill behind the icon; screen readers hear it
/// as selected. The other tabs are muted, their labels semi-bold. The whole item is one button,
/// at least 48 dp, that grows with the text, so a label is never cut at large text sizes.
class MainNavigationItem extends StatelessWidget {
  const MainNavigationItem({
    super.key,
    required this.tab,
    required this.isCurrent,
    required this.onTap,
  });

  final MainTab tab;

  /// Whether this is the tab on screen.
  final bool isCurrent;

  final VoidCallback onTap;

  /// The weight of the current tab's label: bold, so it is told apart without colour.
  static const FontWeight currentLabelWeight = FontWeight.w700;

  /// The weight of the other tabs' labels.
  static const FontWeight otherLabelWeight = FontWeight.w600;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final label = tab.labelOf(AppLocalizations.of(context));
    final colour = isCurrent ? colours.accent : colours.muted;
    return Semantics(
      button: true,
      selected: isCurrent,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: tokens.sizes.touchTargetMinimum),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: spacing.space1, vertical: spacing.space2),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: isCurrent ? colours.accentSoft : null,
                    borderRadius: BorderRadius.circular(tokens.radii.pill),
                  ),
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: spacing.space4,
                      vertical: spacing.space1,
                    ),
                    child: Icon(tab.icon, size: spacing.space6, color: colour),
                  ),
                ),
                SizedBox(height: spacing.space1),
                Text(
                  label,
                  textAlign: TextAlign.center,
                  style: tokens.typeStyles.caption.copyWith(
                    color: colour,
                    fontWeight: isCurrent ? currentLabelWeight : otherLabelWeight,
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
