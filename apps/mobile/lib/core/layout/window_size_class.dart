import 'package:flutter/widgets.dart';

import '../theme/look_up_tokens.dart';

/// The Material 3 window size class of the window the app is drawn in (design §3.19,
/// P6-RESPONSIVE-02), read from its width against the tokens' breakpoints (600 and 840 dp).
///
/// This is the one place that turns a width into a layout: screens ask for the class, never for a
/// width of their own. It reads `MediaQuery.sizeOf`, so a widget rebuilds only when the size
/// changes, and a phone turned on its side (800 × 360) is "medium" by its width and reflows.
enum WindowSizeClass {
  /// Below 600 dp: phones held upright. One column and the bottom tab bar.
  compact,

  /// 600 to 839 dp: small tablets, and phones on their side. A navigation rail at the left.
  medium,

  /// 840 dp and wider: tablets. The rail, and two panes per tab.
  expanded;

  /// The class of the window [context] is drawn in.
  static WindowSizeClass of(BuildContext context) =>
      forWidth(MediaQuery.sizeOf(context).width, breakpoints: context.lookUpTokens.breakpoints);

  /// The class of a window [width] logical pixels wide, by [breakpoints].
  static WindowSizeClass forWidth(
    double width, {
    LookUpBreakpoints breakpoints = LookUpBreakpoints.standard,
  }) {
    if (width >= breakpoints.expanded) return WindowSizeClass.expanded;
    if (width >= breakpoints.medium) return WindowSizeClass.medium;
    return WindowSizeClass.compact;
  }
}
