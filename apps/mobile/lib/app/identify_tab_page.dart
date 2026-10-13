import 'package:flutter/material.dart';
import 'package:lookup_listener/app/two_panes.dart';
import 'package:lookup_listener/core/layout/window_size_class.dart';

/// The Identify tab (P6 design §3.19): Home on a phone and at medium width; at expanded width Home
/// and History side by side (P6-RESPONSIVE-05). A Result takes History's place beside Home
/// (`ResultBesideHome`).
class IdentifyTabPage extends StatelessWidget {
  const IdentifyTabPage({super.key, required this.home, required this.history});

  final Widget home;
  final Widget history;

  @override
  Widget build(BuildContext context) {
    if (WindowSizeClass.of(context) != WindowSizeClass.expanded) return home;
    return TwoPanes(start: home, end: history);
  }
}
