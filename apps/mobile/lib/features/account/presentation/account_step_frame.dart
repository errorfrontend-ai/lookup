import 'package:flutter/material.dart';
import 'package:lookup_listener/core/layout/room_sized_media_query.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// The frame of the sign-up steps (ADR-005, design §3.1): the screen frame's layout (safe area, one exit button and
/// a heading, a centred column at most as wide as a compact window, a footer of full-width actions), with a body that
/// is a plain scroll view. The steps hold text fields, chips and a checkbox, whose heights the shared frame cannot
/// measure ahead of laying them out; here the body simply scrolls when the keyboard or large text leaves it too little
/// room, and the main button stays in reach above the keyboard.
class AccountStepFrame extends StatelessWidget {
  const AccountStepFrame({super.key, required this.exitButton, required this.heading, required this.body, required this.footer});

  /// The Back arrow at the top left, usually a `ScreenExitButton`.
  final Widget exitButton;

  /// The step's heading, read as a heading.
  final String heading;

  /// The step's content under the heading.
  final List<Widget> body;

  /// The actions at the bottom, top to bottom, each stretched to the full width.
  final List<Widget> footer;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: tokens.breakpoints.medium),
            child: RoomSizedMediaQuery(
              child: LayoutBuilder(
                builder: (context, constraints) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: EdgeInsets.fromLTRB(spacing.space2, spacing.space3, spacing.space2, 0),
                      child: Row(children: [exitButton]),
                    ),
                    Expanded(
                      child: SingleChildScrollView(
                        padding: EdgeInsets.fromLTRB(spacing.space6, spacing.space4, spacing.space6, spacing.space4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Semantics(header: true, child: Text(heading, style: tokens.typeStyles.headline)),
                            SizedBox(height: spacing.space3),
                            ...body,
                          ],
                        ),
                      ),
                    ),
                    // At most half the height, so a very large text size cannot leave the body no room.
                    ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: constraints.maxHeight / 2),
                      child: SingleChildScrollView(
                        child: Padding(
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
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
