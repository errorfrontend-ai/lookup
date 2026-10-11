import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Home's one big control (design §2.2; wireframe Main): a 200 dp accent disc with the microphone
/// above "Tap to identify" (`identifyButtonLabel`), inside two soft halo rings, low on the screen
/// where a thumb reaches it.
///
/// Screen readers hear "Identify the ad playing now" (`identifyButtonSpokenLabel`), a button: the
/// drawn words assume the listener can see the disc.
///
/// At larger text sizes the disc grows with the text (200 dp times the text scale), so its words
/// are drawn at the size the listener chose (S4-RESPONSIVE-03). It grows no wider than the screen
/// less a halo ring on each side, which also keeps it inside Home's 24 dp side gutters. The words
/// wrap between words, never inside one; only when even the widest disc cannot hold them at the
/// listener's size do they shrink, all together, to fit inside it rather than spill out of it.
class IdentifyButton extends StatelessWidget {
  const IdentifyButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final label = words.identifyButtonLabel;
    // 200 dp across at normal text, a 56 dp icon; rings 12 and 28 dp wide (the wireframe's 14 dp
    // ring is taken to the nearest token, design §2.1).
    final standardDiameter = spacing.space10 * 5;
    final innerRingWidth = spacing.space3;
    final outerRingWidth = spacing.space6 + spacing.space1;
    final contentPadding = spacing.space4;
    final labelStyle = tokens.typeStyles.heading.copyWith(
      fontWeight: FontWeight.w700,
      color: colours.onAccent,
    );

    final textScaler = MediaQuery.textScalerOf(context);
    final fontSize = labelStyle.fontSize!;
    // The scale the label is drawn at (Android scales large text less than small text).
    final textScale = textScaler.scale(fontSize) / fontSize;
    // The width is read from MediaQuery, not a LayoutBuilder: ScreenFrame measures Home's natural
    // height, which a LayoutBuilder cannot report.
    final widestDiameter = MediaQuery.sizeOf(context).width - 2 * outerRingWidth;
    final diameter = math.min(standardDiameter * math.max(1.0, textScale), widestDiameter);
    // The words are laid out at least as wide as their longest word, so a word too wide for the
    // disc makes the whole label shrink instead of breaking in the middle.
    final layoutWidth = math.max(
      diameter - 2 * contentPadding,
      _widestWordWidth(
        label,
        DefaultTextStyle.of(context).style.merge(labelStyle),
        textScaler,
        context,
      ),
    );
    return Semantics(
      button: true,
      label: words.identifyButtonSpokenLabel,
      onTap: onPressed,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          // Painted in order: the wider, fainter ring first, the accent-soft ring on it.
          boxShadow: [
            BoxShadow(
              color: colours.accentSoft.withValues(alpha: 0.5),
              spreadRadius: outerRingWidth,
            ),
            BoxShadow(color: colours.accentSoft, spreadRadius: innerRingWidth),
          ],
        ),
        child: Material(
          color: colours.accent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox.square(
              dimension: diameter,
              child: Padding(
                padding: EdgeInsets.all(contentPadding),
                // Shrinks only what does not fit at the listener's size; otherwise draws it as is.
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: SizedBox(
                    width: layoutWidth,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.mic_none, size: spacing.space14, color: colours.onAccent),
                        SizedBox(height: spacing.space2),
                        Text(label, textAlign: TextAlign.center, style: labelStyle),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// How wide [label]'s longest word is when drawn in [style] at the listener's text size.
  static double _widestWordWidth(
    String label,
    TextStyle style,
    TextScaler textScaler,
    BuildContext context,
  ) {
    var widest = 0.0;
    for (final word in label.split(' ')) {
      final painter = TextPainter(
        text: TextSpan(text: word, style: style),
        textDirection: Directionality.of(context),
        textScaler: textScaler,
        maxLines: 1,
      )..layout();
      widest = math.max(widest, painter.width.ceilToDouble());
      painter.dispose();
    }
    return widest;
  }
}
