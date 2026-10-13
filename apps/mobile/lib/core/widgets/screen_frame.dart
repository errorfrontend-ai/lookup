import 'package:flutter/material.dart';

import '../layout/room_sized_media_query.dart';
import '../theme/look_up_tokens.dart';

/// The frame every screen sits in (design §2.1), so the layout rules live in one place: the safe
/// area, a header with one exit button and an optional title, the body, and a footer of full-width
/// actions at the bottom.
///
/// The screen is one `CustomScrollView` whose only sliver is `SliverFillRemaining(hasScrollBody:
/// false)`: on a tall phone the footer sits at the bottom, and when the text is large the whole
/// screen scrolls instead of overflowing. Nothing has a fixed height around text.
///
/// With [isFooterPinned], only the body scrolls: the header and the footer stay on screen.
///
/// The frame measures the body's natural height to decide whether to scroll, so the body must not
/// use `LayoutBuilder` (which cannot report a natural height); read the width from
/// `MediaQuery.sizeOf` instead.
///
/// On a wide window the screen is one centred column at most as wide as a compact window (600 dp,
/// the medium breakpoint; P6 design §3.19), so a line of text never runs across a tablet.
class ScreenFrame extends StatelessWidget {
  const ScreenFrame({
    super.key,
    required this.body,
    this.exitButton,
    this.title,
    this.footer = const <Widget>[],
    this.isBodyAtBottom = false,
    this.bodyPadding,
    this.bodyTop,
    this.isFooterPinned = false,
  });

  /// The screen's content between the header and the footer.
  final Widget body;

  /// The Back or Close button at the top left, usually a `ScreenExitButton`.
  final Widget? exitButton;

  /// Text in the header: beside [exitButton] ("Found it"), or on its own at the top left with
  /// 20 dp padding when there is no button ("Look Up" on Home).
  final Widget? title;

  /// The actions at the bottom, top to bottom, each stretched to the full width with 8 dp between
  /// them and 24 dp around: usually a `FilledButton` (at least 52 dp tall through the theme), then
  /// a `TextButton` (at least 48 dp).
  final List<Widget> footer;

  /// Puts the body at the bottom of the space it has, in the thumb zone (Home), instead of at the
  /// top.
  final bool isBodyAtBottom;

  /// Space around the body; the wireframes' 24 dp on the sides and top when not given.
  final EdgeInsetsGeometry? bodyPadding;

  /// Content at the top of the body's space, above the room that keeps [body] at the bottom when
  /// [isBodyAtBottom]: Home's first-open note sits under the header while "Tap to identify" stays
  /// in the thumb zone. Like the body, it scrolls with the screen when the text is large.
  final Widget? bodyTop;

  /// Keeps the header and the footer on screen while only the body scrolls between them, so the
  /// screen's main action is in reach however long the body is: Permission's three promises put
  /// "Allow microphone" below the fold of a 360 × 800 phone (P6 design §2.4). The footer takes at
  /// most half the height; with very large text it scrolls within that half rather than leave the
  /// body no room. A body taller than its room shows its scrollbar, so the listener can see that
  /// more follows (the Saved screen's bell panel, under its buttons on a 360 × 800 phone).
  final bool isFooterPinned;

  @override
  Widget build(BuildContext context) {
    final header = _buildHeader(context);
    final bodyArea = _buildBodyArea(context);
    final footerArea = footer.isEmpty ? null : _buildFooterArea(context);
    final columnWidth = context.lookUpTokens.breakpoints.medium;
    Widget inColumn(Widget child) => Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: columnWidth),
        // Inside the column the window is the column: what sizes itself from the window fits it.
        child: RoomSizedMediaQuery(child: child),
      ),
    );
    if (isFooterPinned) {
      return Scaffold(
        body: SafeArea(
          child: inColumn(
            LayoutBuilder(
              builder: (context, constraints) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ?header,
                  Expanded(child: _ScrollingBody(child: bodyArea)),
                  if (footerArea != null)
                    ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: constraints.maxHeight / 2),
                      child: SingleChildScrollView(child: footerArea),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return Scaffold(
      body: SafeArea(
        child: inColumn(
          CustomScrollView(
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ?header,
                    Expanded(child: bodyArea),
                    ?footerArea,
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBodyArea(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    return Padding(
      padding:
          bodyPadding ?? EdgeInsets.fromLTRB(spacing.space6, spacing.space6, spacing.space6, 0),
      child: Column(
        mainAxisAlignment: isBodyAtBottom ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ...?switch (bodyTop) {
            final bodyTop? => [bodyTop, if (isBodyAtBottom) const Spacer()],
            null => null,
          },
          body,
        ],
      ),
    );
  }

  Widget _buildFooterArea(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    return Padding(
      padding: EdgeInsets.all(spacing.space6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (index, action) in footer.indexed) ...[
            if (index > 0) SizedBox(height: spacing.space2),
            action,
          ],
        ],
      ),
    );
  }

  Widget? _buildHeader(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    final exitButton = this.exitButton;
    final title = this.title;
    if (exitButton == null) {
      if (title == null) return null;
      return Padding(
        padding: EdgeInsets.fromLTRB(spacing.space5, spacing.space5, spacing.space5, 0),
        child: title,
      );
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(spacing.space2, spacing.space3, spacing.space2, 0),
      child: Row(
        children: [
          exitButton,
          if (title != null) ...[SizedBox(width: spacing.space1), Expanded(child: title)],
        ],
      ),
    );
  }
}

/// The body of a frame with a pinned footer: it scrolls on its own, with its scrollbar always shown
/// while there is more than fits.
class _ScrollingBody extends StatefulWidget {
  const _ScrollingBody({required this.child});

  final Widget child;

  @override
  State<_ScrollingBody> createState() => _ScrollingBodyState();
}

class _ScrollingBodyState extends State<_ScrollingBody> {
  final ScrollController _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scrollbar(
    controller: _controller,
    thumbVisibility: true,
    child: CustomScrollView(
      controller: _controller,
      slivers: [SliverFillRemaining(hasScrollBody: false, child: widget.child)],
    ),
  );
}
