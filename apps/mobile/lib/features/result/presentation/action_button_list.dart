import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/result/data/action_launcher.dart';
import 'package:lookup_listener/features/result/domain/read_action_card.dart';
import 'package:lookup_listener/features/result/domain/ui_action.dart';
import 'package:lookup_listener/features/result/presentation/action_registry.dart';
import 'package:lookup_listener/features/result/presentation/launch_failure_sheet.dart';
import 'package:lookup_listener/features/result/presentation/more_options_button.dart';

/// The station's buttons under the Result card (design §2.6, §3.13): one full-width button per
/// row, 8 dp apart, in the card's order (never re-sorted; conflict 18). The first four show at once;
/// when the card has five or six, "More options" under the fourth reveals the rest in place and
/// disappears (S4-D18), so the app splits a card exactly as the portal's preview does.
///
/// A tap builds the address in the app (never one the server sent for call, WhatsApp or map) and
/// opens it in an external app; when the phone cannot, the copy sheet offers the number or link.
class ActionButtonList extends ConsumerStatefulWidget {
  const ActionButtonList({
    super.key,
    required this.card,
    required this.showsIcons,
    this.registry = ActionRegistry.standard,
  });

  /// The buttons, as the card reader read them.
  final ReadActionCard card;

  /// False below 360 dp wide, where Result320 draws the labels alone.
  final bool showsIcons;

  final ActionRegistry registry;

  @override
  ConsumerState<ActionButtonList> createState() => _ActionButtonListState();
}

class _ActionButtonListState extends ConsumerState<ActionButtonList> {
  bool _isShowingMoreOptions = false;

  /// True while the phone is opening an address, so a second tap does not open it twice.
  bool _isOpening = false;

  @override
  Widget build(BuildContext context) {
    final card = widget.card;
    final moreOptionsButtons = _buttonsFor(card.moreOptionsActions);
    final rows = <Widget>[
      ..._buttonsFor(card.visibleActions),
      if (_isShowingMoreOptions)
        ...moreOptionsButtons
      else if (moreOptionsButtons.isNotEmpty)
        MoreOptionsButton(onPressed: () => setState(() => _isShowingMoreOptions = true)),
    ];
    switch (card.layout) {
      case ActionCardLayout.verticalStack:
        final gap = context.lookUpTokens.spacing.space2;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (index, row) in rows.indexed) ...[if (index > 0) SizedBox(height: gap), row],
          ],
        );
    }
  }

  /// One button for each action the registry serves, in the order given.
  List<Widget> _buttonsFor(List<UiAction> actions) {
    return [
      for (final action in actions)
        if (widget.registry.registrationFor(action) case final registration?)
          registration.buildButton(
            action,
            showsIcon: widget.showsIcons,
            onPressed: () => unawaited(_open(action, registration)),
          ),
    ];
  }

  Future<void> _open(UiAction action, ActionRegistration<UiAction> registration) async {
    final address = registration.buildAddress(action);
    // A button whose address is nothing opens nothing (S4-LINKS-07).
    if (address == null || _isOpening) return;
    _isOpening = true;
    final bool hasOpened;
    try {
      hasOpened = await ref.read(actionLauncherProvider).open(address);
    } finally {
      _isOpening = false;
    }
    if (hasOpened || !mounted) return;
    final copyOffer = registration.buildCopyOffer(action, address);
    if (copyOffer == null) return;
    await LaunchFailureSheet.show(context, copyOffer);
  }
}
