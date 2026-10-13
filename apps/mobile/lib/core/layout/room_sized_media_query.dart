import 'package:flutter/widgets.dart';

/// Tells everything inside it that the window is exactly the room it has: a pane beside another, or
/// the centred column of a wide window (P6 design §3.19). Screens size some things from
/// `MediaQuery.sizeOf` (Home's header, the Result's icons, the window size class), so in a pane they
/// lay out as on a phone of the pane's width, instead of for a window they do not fill.
class RoomSizedMediaQuery extends StatelessWidget {
  const RoomSizedMediaQuery({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final data = MediaQuery.of(context);
        final size = Size(
          constraints.hasBoundedWidth ? constraints.maxWidth : data.size.width,
          constraints.hasBoundedHeight ? constraints.maxHeight : data.size.height,
        );
        // Always wrapped, so the child keeps its state when the room changes size.
        return MediaQuery(
          data: data.copyWith(size: size),
          child: child,
        );
      },
    );
  }
}
