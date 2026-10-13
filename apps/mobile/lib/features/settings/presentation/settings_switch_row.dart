import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// A Settings row with a switch (P6 design §2.11): its title, a note under it, and the switch on the
/// right. The whole row toggles it, and a screen reader reads it as one switch with its label,
/// state and note (P6-DATASAVER-04).
class SettingsSwitchRow extends StatelessWidget {
  const SettingsSwitchRow({
    super.key,
    required this.title,
    required this.note,
    required this.isOn,
    required this.onChanged,
  });

  /// At least this tall (the wireframe's 64 dp).
  static const double minimumHeight = 64;

  final String title;
  final String note;

  /// The switch's state; null while it is still being read, when the row cannot be tapped.
  final bool? isOn;

  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final isOn = this.isOn;
    void toggle() {
      if (isOn != null) onChanged(!isOn);
    }

    return Semantics(
      container: true,
      toggled: isOn ?? false,
      enabled: isOn != null,
      label: '$title\n$note',
      onTap: isOn == null ? null : toggle,
      excludeSemantics: true,
      child: InkWell(
        onTap: isOn == null ? null : toggle,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minimumHeight),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: spacing.space4, vertical: spacing.space3),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: typeStyles.body.copyWith(fontWeight: FontWeight.w700)),
                      Text(note, style: typeStyles.caption.copyWith(color: colours.muted)),
                    ],
                  ),
                ),
                SizedBox(width: spacing.space3),
                Switch(value: isOn ?? false, onChanged: isOn == null ? null : (_) => toggle()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
