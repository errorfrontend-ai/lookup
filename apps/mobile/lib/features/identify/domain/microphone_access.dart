/// What the phone says about the microphone for Look Up (S4-D22; gap 31).
///
/// The permission adapter maps the operating system's status to one of these; the flow reads it
/// before every identify and never shows the system prompt unless the listener tapped
/// "Allow microphone". The three refusal-side values are the Permission screen's three variants.
enum MicrophoneAccess {
  /// The app has never shown the system prompt: the explainer is shown as drawn.
  notAskedYet,

  /// The listener chose "Don't allow" once; "Allow microphone" asks the system again.
  refusedOnce,

  /// The system will not ask again (permanently denied or restricted): only the phone's settings
  /// can turn the microphone on, so the screen's primary button opens them.
  refusedForGood,

  /// Recording may start at once.
  granted,
}
