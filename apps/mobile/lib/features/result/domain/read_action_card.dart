import 'package:lookup_listener/features/result/domain/ui_action.dart';

/// How the buttons are arranged. Only a vertical stack exists today; any layout a card names,
/// known or not, reads as [verticalStack] (reader rule R4), so a later `GRID` card still shows.
enum ActionCardLayout { verticalStack }

/// A card as the Result screen shows it: what the tolerant reader made of the station's card.
///
/// Mirrors the shared TypeScript reader's output, so the app and the portal's preview show the same
/// buttons for the same card.
final class ReadActionCard {
  const ReadActionCard({
    required this.visibleActions,
    required this.moreOptionsActions,
    required this.skippedUnknownTypeCount,
    required this.skippedInvalidCount,
    required this.showsUpdateAppHint,
    this.layout = ActionCardLayout.verticalStack,
  });

  /// A card with no buttons: what anything unreadable, or too new, reads as (rules R7 and R9).
  const ReadActionCard.empty({required this.showsUpdateAppHint})
    : visibleActions = const [],
      moreOptionsActions = const [],
      skippedUnknownTypeCount = 0,
      skippedInvalidCount = 0,
      layout = ActionCardLayout.verticalStack;

  final ActionCardLayout layout;

  /// Shown as buttons, in the card's order (never re-sorted). At most four.
  final List<UiAction> visibleActions;

  /// Shown under "More options", in the card's order. At most two, so at most six buttons in all.
  final List<UiAction> moreOptionsActions;

  /// Actions of a type this app does not know (a newer card); they are why the update hint shows.
  final int skippedUnknownTypeCount;

  /// Actions of a known type whose fields could not be used; they never show the update hint.
  final int skippedInvalidCount;

  /// "Some buttons need a newer version of Look Up." True when the card is too new, or when nothing
  /// could be shown and at least one action was of an unknown type (rules R7 and R8).
  final bool showsUpdateAppHint;

  /// Every action the screen can show: the visible ones, then those under "More options".
  List<UiAction> get shownActions => [...visibleActions, ...moreOptionsActions];
}
