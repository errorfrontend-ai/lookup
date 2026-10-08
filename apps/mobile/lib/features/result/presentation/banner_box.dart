import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';
import 'package:lookup_listener/features/result/presentation/public_image_view.dart';

/// The ad's banner at the top of the Result card (design §2.6, S4-RESULT-04): a box of fixed 2:1
/// shape, the card's full width, filled with the line-soft colour while the image loads and if it
/// never does. The box has its final size before the first byte arrives, so nothing on the screen
/// moves when the image appears.
///
/// The screen builds it only when the card has a banner (S4-D20); the wireframe's
/// "[Ad image · 2:1]" placeholder is never shown.
class BannerBox extends StatelessWidget {
  const BannerBox({super.key, required this.image, required this.width});

  final PublicImage image;

  /// The box's width in logical pixels (the card's width); with the 2:1 shape it gives the size the
  /// image is decoded at.
  final double width;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final aspectRatio = tokens.sizes.bannerAspectRatio;
    return AspectRatio(
      aspectRatio: aspectRatio,
      child: ColoredBox(
        color: tokens.colours.lineSoft,
        child: PublicImageView(image: image, displaySize: Size(width, width / aspectRatio)),
      ),
    );
  }
}
