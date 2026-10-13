import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/public_image_view.dart';

/// A station's logo where stations are listed (P6 design §2.6, §2.12): 40 dp with medium corners,
/// or the first letter of its name in the surface colour on [fillColour] (ink, muted or accent by
/// the row's place); the letter also shows while a logo loads and if it never does.
///
/// Hidden from screen readers: the row's label names the station.
class StationLogo extends StatelessWidget {
  const StationLogo({super.key, required this.stationName, required this.fillColour, this.logo});

  final String stationName;

  /// The square behind the letter, from the tokens.
  final Color fillColour;

  final PublicImage? logo;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final size = tokens.spacing.space10;
    final logo = this.logo;
    final trimmedName = stationName.trim();
    final initial = trimmedName.isEmpty ? '' : trimmedName.characters.first.toUpperCase();
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(tokens.radii.medium),
          child: ColoredBox(
            color: fillColour,
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
