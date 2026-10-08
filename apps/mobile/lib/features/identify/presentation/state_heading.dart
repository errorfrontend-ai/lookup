import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// A state screen's heading ("Listening…", "No connection", "Something went wrong on our side"):
/// read as a heading, and announced as soon as it appears, because the screen changed without the
/// listener touching anything (design §2.4 to §2.10).
///
/// Two semantics nodes, because Flutter refuses a node that is both a live region and a status or
/// alert: the outer one carries [role] (an alert for failures that need attention, a status for the
/// rest), the inner one is the heading and the live region that Android's TalkBack announces.
class StateHeading extends StatelessWidget {
  const StateHeading(this.text, {super.key, required this.role, this.textAlign});

  final String text;

  /// `SemanticsRole.status` or `SemanticsRole.alert`.
  final SemanticsRole role;

  /// Centred on Listening and Identifying; at the start elsewhere, as the wireframes draw them.
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      role: role,
      child: Semantics(
        container: true,
        header: true,
        liveRegion: true,
        child: Text(text, textAlign: textAlign, style: context.lookUpTokens.typeStyles.headline),
      ),
    );
  }
}
