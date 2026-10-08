import 'package:flutter/material.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';

/// "Send a test error": a development-only control on Home that throws on purpose, so the
/// developer can prove a crash travels all the way to the API's log (the debug-throw check,
/// P6-TESTS-13, run first at the Step 4 gate; S4-D26).
///
/// Flutter catches the throw from the tap and hands it to `FlutterError.onError`, which the global
/// handlers turn into one crash report with its own request id. Home shows it only when the build
/// is the development flavour with `LOOKUP_SHOW_DEVELOPER_TOOLS=true`, which the configuration
/// check refuses in any other flavour, so it can never exist in staging or production.
class SendTestErrorButton extends StatelessWidget {
  const SendTestErrorButton({super.key});

  /// The words on the control.
  static const String label = 'Send a test error';

  /// The error's own words, which the crash report carries.
  static const String errorDescription = 'A test error, thrown on purpose from the developer tools';

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: () => throw StateError(errorDescription),
      style: TextButton.styleFrom(textStyle: context.lookUpTokens.typeStyles.label),
      child: const Text(label),
    );
  }
}
