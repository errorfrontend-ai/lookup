import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/public_image_view.dart';

/// The advertiser's round logo in the Result card's client row (design §2.6, S4-RESULT-06): the
/// client's logo when the answer has one, otherwise the first letter of the client's name, upper
/// case, in the surface colour on ink, as the wireframes draw "A" for "Brand A". The letter also
/// shows while a logo loads and if it never does, so the circle is never empty.
///
/// History's rows draw the same circle, its letter on ink, muted or accent by the row's place
/// ([fillColour]; P6 design §2.9).
///
/// Hidden from screen readers: the client's name beside it is read instead.
class ClientLogo extends StatelessWidget {
  const ClientLogo({
    super.key,
    required this.clientName,
    required this.diameter,
    this.logo,
    this.fillColour,
  });

  final String clientName;

  /// 40 dp, or 36 dp below 360 dp wide (Result320).
  final double diameter;

  final PublicImage? logo;

  /// The circle behind the letter, from the tokens; ink when not given.
  final Color? fillColour;

  /// The letter shown without a logo: the name's first character as a person sees it (a whole
  /// emoji or accented letter, not half of one), upper case; empty for a blank name.
  static String initialOf(String clientName) {
    final trimmedName = clientName.trim();
    return trimmedName.isEmpty ? '' : trimmedName.characters.first.toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final logo = this.logo;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: diameter,
        child: ClipOval(
          child: ColoredBox(
            color: fillColour ?? colours.ink,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Center(
                  // The circle keeps its size at large text sizes; the letter shrinks to fit it
                  // instead of being cut off.
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      initialOf(clientName),
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
                    displaySize: Size.square(diameter),
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
