import 'package:flutter/material.dart';

import '../theme/look_up_tokens.dart';

/// The frame every screen sits in (design §2.1), so the layout rules live in one place: the safe
/// area, a header with one exit button and an optional title, the body, and a footer of full-width
/// actions at the bottom.
///
/// The screen is one `CustomScrollView` whose only sliver is `SliverFillRemaining(hasScrollBody:
/// false)`: on a tall phone the footer sits at the bottom, and when the text is large the whole
/// screen scrolls instead of overflowing. Nothing has a fixed height around text.
///
/// The frame measures the body's natural height to decide whether to scroll, so the body must not
/// use `LayoutBuilder` (which cannot report a natural height); read the width from
/// `MediaQuery.sizeOf` instead.
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

  @override
  Widget build(BuildContext context) {
    final spacing = context.lookUpTokens.spacing;
    final header = _buildHeader(context);
    return Scaffold(
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            SliverFillRemaining(
              hasScrollBody: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ?header,
                  Expanded(
                    child: Padding(
                      padding:
                          bodyPadding ??
                          EdgeInsets.fromLTRB(spacing.space6, spacing.space6, spacing.space6, 0),
                      child: Column(
                        mainAxisAlignment: isBodyAtBottom
                            ? MainAxisAlignment.end
                            : MainAxisAlignment.start,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ...?switch (bodyTop) {
                            final bodyTop? => [bodyTop, if (isBodyAtBottom) const Spacer()],
                            null => null,
                          },
                          body,
                        ],
                      ),
                    ),
                  ),
                  if (footer.isNotEmpty)
                    Padding(
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
                    ),
                ],
              ),
            ),
          ],
        ),
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
