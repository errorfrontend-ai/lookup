import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// Two panes side by side at expanded width (P6 design §3.19; P6-RESPONSIVE-05): [start] at the left,
/// [end] at the right, each half of the room the rail leaves, with a 1 dp line between them. Each
/// pane keeps its own safe area on its outer side only.
class TwoPanes extends StatelessWidget {
  const TwoPanes({super.key, required this.start, required this.end});

  final Widget start;
  final Widget end;

  @override
  Widget build(BuildContext context) {
    final colours = context.lookUpTokens.colours;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: MediaQuery.removePadding(context: context, removeRight: true, child: start),
        ),
        ColoredBox(color: colours.line, child: const SizedBox(width: 1)),
        Expanded(
          child: MediaQuery.removePadding(context: context, removeLeft: true, child: end),
        ),
      ],
    );
  }
}

/// The right pane before anything is opened in it: one short line, centred, in the muted colour.
class PaneNote extends StatelessWidget {
  const PaneNote({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(tokens.spacing.space6),
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: tokens.typeStyles.body.copyWith(color: tokens.colours.muted),
            ),
          ),
        ),
      ),
    );
  }
}
