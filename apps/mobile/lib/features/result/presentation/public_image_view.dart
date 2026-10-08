import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lookup_listener/features/result/data/https_image_provider.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// An image from the recognize answer (the banner or the client's logo), covering the box its parent
/// gives it. The parent fixes the box's size, so nothing moves when the image arrives, and the
/// parent's own fill shows while it loads and if it never does.
///
/// Only `https` addresses are fetched (S4-D15): the answer's reader already drops any other, this
/// second check keeps a plain-text download off the phone even if that ever changes, and the image
/// loads through [HttpsImageProvider], which follows a redirect only to another `https` address.
/// The image is decoded at the size it is shown (see [decodeSizeFor]), so a large upload never costs
/// a cheap phone more memory than the box needs.
class PublicImageView extends StatelessWidget {
  const PublicImageView({
    super.key,
    required this.image,
    required this.displaySize,
    this.loadedBackgroundColour,
  });

  final PublicImage image;

  /// The box's size in logical pixels: the image covers it, cut at the sides or the top and bottom.
  final Size displaySize;

  /// Painted behind the image once it has loaded, so a logo with transparent parts does not show
  /// what was drawn under it while it loaded.
  final Color? loadedBackgroundColour;

  /// Whether [image] may be downloaded at all: an absolute `https` address with a host.
  static bool canShow(PublicImage image) {
    final address = Uri.tryParse(image.address);
    return address != null && HttpsImageProvider.isHttpsAddress(address);
  }

  /// The size to decode [image] at, in physical pixels, for a box of [displaySize] that it covers:
  /// one side only, so the other follows the image's own shape (from the answer's
  /// `width_pixels` and `height_pixels`).
  ///
  /// An image wider than the box, for its height, fills the box's height and is cut at the sides,
  /// so it is decoded at the box's height ([cacheHeight]); decoded at the box's width it would be
  /// shorter than the box and stretched, blurred, to cover it. Any other image fills the box's
  /// width and is decoded at that ([cacheWidth]).
  static ({int? cacheWidth, int? cacheHeight}) decodeSizeFor(
    PublicImage image,
    Size displaySize,
    double devicePixelRatio,
  ) {
    int physicalPixels(double logicalPixels) =>
        math.max(1, (logicalPixels * devicePixelRatio).round());
    final isWiderThanBox =
        image.widthPixels > 0 &&
        image.heightPixels > 0 &&
        image.widthPixels * displaySize.height > image.heightPixels * displaySize.width;
    if (isWiderThanBox) return (cacheWidth: null, cacheHeight: physicalPixels(displaySize.height));
    return (cacheWidth: physicalPixels(displaySize.width), cacheHeight: null);
  }

  @override
  Widget build(BuildContext context) {
    if (!canShow(image)) return const SizedBox.shrink();
    final loadedBackgroundColour = this.loadedBackgroundColour;
    final decodeSize = decodeSizeFor(image, displaySize, MediaQuery.devicePixelRatioOf(context));
    return Image(
      image: ResizeImage.resizeIfNeeded(
        decodeSize.cacheWidth,
        decodeSize.cacheHeight,
        HttpsImageProvider(image.address),
      ),
      fit: BoxFit.cover,
      // The heading and the client's name say what the image shows; there is no description of
      // the picture itself to read out.
      excludeFromSemantics: true,
      frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
        final hasLoaded = frame != null || wasSynchronouslyLoaded;
        if (!hasLoaded || loadedBackgroundColour == null) return child;
        return ColoredBox(color: loadedBackgroundColour, child: child);
      },
      // A failed download is normal on a weak signal: the parent's fill stays, and nothing is
      // reported or shown.
      errorBuilder: (_, _, _) => const SizedBox.shrink(),
    );
  }
}
