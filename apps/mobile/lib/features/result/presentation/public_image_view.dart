import 'package:flutter/material.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// An image from the recognize answer (the banner or the client's logo), filling the box its parent
/// gives it. The parent fixes the box's size, so nothing moves when the image arrives, and the
/// parent's own fill shows while it loads and if it never does.
///
/// Only `https` addresses are fetched (S4-D15): the answer's reader already drops any other, and
/// this second check keeps a plain-text download off the phone even if that ever changes. The
/// image is decoded at the size it is shown ([displayWidth] × the screen's pixel ratio), so a large
/// upload never costs a cheap phone more memory than the box needs.
class PublicImageView extends StatelessWidget {
  const PublicImageView({
    super.key,
    required this.image,
    required this.displayWidth,
    this.loadedBackgroundColour,
  });

  final PublicImage image;

  /// The box's width in logical pixels.
  final double displayWidth;

  /// Painted behind the image once it has loaded, so a logo with transparent parts does not show
  /// what was drawn under it while it loaded.
  final Color? loadedBackgroundColour;

  /// Whether [image] may be downloaded at all: an absolute `https` address with a host.
  static bool canShow(PublicImage image) {
    final address = Uri.tryParse(image.address);
    return address != null && address.scheme == 'https' && address.host.isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    if (!canShow(image)) return const SizedBox.shrink();
    final loadedBackgroundColour = this.loadedBackgroundColour;
    return Image.network(
      image.address,
      fit: BoxFit.cover,
      cacheWidth: (displayWidth * MediaQuery.devicePixelRatioOf(context)).round(),
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
