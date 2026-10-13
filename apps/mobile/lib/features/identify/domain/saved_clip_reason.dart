/// Why the live flow kept a clip for later (P6 design §2.8): the Saved screen's three reasons, each
/// with its own icon, heading and text.
enum SavedClipReason {
  /// No answer to the send or to the registration before it (T27′).
  noConnection,

  /// Still busy on the fourth send, or the app hidden during Busy (T21′, T31′).
  busy,

  /// A 429 to the send or to the registration before it (T24′).
  tooManyTries,
}
