import 'package:flutter/material.dart';

import '../theme/look_up_tokens.dart';

/// What `ErrorWidget.builder` shows in place of a widget that failed to build (design §2.11): a
/// small plain box reading "This part couldn't be shown." instead of Flutter's red error screen, in
/// every build, so a listener never sees exception text. Only a development build with
/// `LOOKUP_SHOW_ERROR_DETAILS` shows the error's own text instead (S4-ERRORHANDLING-08). The error
/// itself is reported by `FlutterError.onError`, not here.
///
/// It can be built anywhere, even above the app's theme or text direction, so it depends on
/// neither, and it never throws itself.
class PlainErrorFallback extends StatelessWidget {
  const PlainErrorFallback({super.key, required this.errorDetails, this.showsErrorDetails = false});

  /// The words every build shows.
  static const String message = "This part couldn't be shown.";

  /// The failure Flutter caught.
  final FlutterErrorDetails errorDetails;

  /// True only in a development build with `LOOKUP_SHOW_ERROR_DETAILS` on
  /// (`AppConfiguration.showsErrorDetails`).
  final bool showsErrorDetails;

  @override
  Widget build(BuildContext context) {
    // Theme.of works with no theme above (it falls back to Flutter's default), which has no tokens.
    final tokens = Theme.of(context).extension<LookUpTokens>() ?? LookUpTokens.light;
    final colours = tokens.colours;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colours.surface,
        border: Border.all(color: colours.lineSoft),
        borderRadius: BorderRadius.circular(tokens.radii.medium),
      ),
      child: Padding(
        padding: EdgeInsets.all(tokens.spacing.space3),
        child: Text(
          _shownText(),
          textDirection: Directionality.maybeOf(context) ?? TextDirection.ltr,
          style: tokens.typeStyles.body.copyWith(
            color: colours.muted,
            // Without a Material ancestor Flutter would underline loose text in yellow.
            decoration: TextDecoration.none,
          ),
        ),
      ),
    );
  }

  String _shownText() {
    if (!showsErrorDetails) return message;
    try {
      return errorDetails.exceptionAsString();
    } on Object {
      // An exception whose own description fails must not break the fallback.
      return message;
    }
  }
}
