import 'dart:async';

import 'package:lookup_listener/features/result/data/action_launcher.dart';

/// Records every address the screen asks to open (design §4.1), and answers as told: [opens] true
/// for a phone that opened it, false for one that could not. With [heldAnswer] set, it answers only
/// when the test completes it, as a phone still switching apps would.
class FakeActionLauncher implements ActionLauncher {
  FakeActionLauncher({this.opens = true});

  /// What [open] answers.
  bool opens;

  /// When set, [open] answers with this completer's value instead of [opens].
  Completer<bool>? heldAnswer;

  /// Every address passed to [open], in order.
  final List<String> openedAddresses = [];

  @override
  Future<bool> open(String address) async {
    openedAddresses.add(address);
    final heldAnswer = this.heldAnswer;
    return heldAnswer == null ? opens : heldAnswer.future;
  }
}
