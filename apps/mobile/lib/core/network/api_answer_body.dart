import 'dart:convert';

/// The body of an answer as the app read it: decoded JSON, or a marker that it was not JSON (a
/// proxy's error page, an empty body, broken text). The app decodes it itself rather than letting
/// Dio do it, so a strange body can never raise an exception carrying technical text (design §3.8).
/// Sealed, so every reader handles both.
sealed class ApiAnswerBody {
  const ApiAnswerBody();

  /// Reads [text] as JSON. Anything that is not one complete JSON value, including an empty body,
  /// gives [NotJsonAnswerBody].
  static ApiAnswerBody fromText(String text) {
    if (text.trim().isEmpty) return const NotJsonAnswerBody();
    try {
      return JsonAnswerBody(jsonDecode(text));
    } on Object {
      // Not JSON, or JSON nested so deeply that decoding it fails: either way, not a body to read.
      return const NotJsonAnswerBody();
    }
  }
}

/// The body was JSON.
final class JsonAnswerBody extends ApiAnswerBody {
  const JsonAnswerBody(this.value);

  /// The decoded value: a map, a list, a string, a number, a boolean or null. Nothing has checked
  /// its shape yet; its reader does that before using any of it (S4-D15).
  final Object? value;
}

/// The body was empty or not JSON.
final class NotJsonAnswerBody extends ApiAnswerBody {
  const NotJsonAnswerBody();
}
