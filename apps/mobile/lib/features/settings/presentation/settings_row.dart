import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// One row of a Settings section (P6 design §2.11; wireframe Settings): its title (16, 700), the
/// detail under it when there is one (13, muted), and a chevron when it opens a page.
///
/// A row with [onTap] is one button, read as its title and detail; one without (Language while
/// there is one) is plain text, read the same way but never offered as a control, so nothing on
/// the screen looks tappable that does nothing (ALL-USABILITY-05). A [isDanger] row ("Clear history")
/// draws its title in the danger colour.
class SettingsRow extends StatelessWidget {
  const SettingsRow({
    super.key,
    required this.title,
    this.detail,
    this.onTap,
    this.showsChevron = false,
    this.isDanger = false,
    this.minimumHeight,
  });

  final String title;

  /// The line under the title; null for none.
  final String? detail;

  /// What a tap does; null for a row that is not a control.
  final VoidCallback? onTap;

  /// Whether the row ends with a chevron: it opens a page.
  final bool showsChevron;

  /// Whether the title is drawn in the danger colour.
  final bool isDanger;

  /// The least height; the smallest tap target when not given.
  final double? minimumHeight;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final detail = this.detail;
    final onTap = this.onTap;
    final content = ConstrainedBox(
      constraints: BoxConstraints(minHeight: minimumHeight ?? tokens.sizes.touchTargetMinimum),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: spacing.space4, vertical: spacing.space3),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: typeStyles.body.copyWith(
                      fontWeight: FontWeight.w700,
                      color: isDanger ? colours.danger : colours.ink,
                    ),
                  ),
                  if (detail != null)
                    Text(detail, style: typeStyles.caption.copyWith(color: colours.muted)),
                ],
              ),
            ),
            if (showsChevron) ...[
              SizedBox(width: spacing.space2),
              ExcludeSemantics(child: Icon(Icons.chevron_right, color: colours.muted)),
            ],
          ],
        ),
      ),
    );
    final label = detail == null ? title : '$title\n$detail';
    if (onTap == null) {
      return Semantics(label: label, excludeSemantics: true, child: content);
    }
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(onTap: onTap, child: content),
    );
  }
}
