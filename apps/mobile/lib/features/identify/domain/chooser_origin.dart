/// Where a "Which station?" sheet came from (P6 design §3.4), which decides where Cancel leads.
enum ChooserOrigin {
  /// The answer to the identify the listener just made (T19′): Cancel goes Home (T46).
  liveIdentify,

  /// A saved `CHOOSE_STATION`, opened from History or its notification (T51): Cancel goes back to
  /// History, where the row still asks for a station (T47).
  savedRecognition,
}
