/// Where a "Which station?" sheet came from (P6 design §3.4), which decides where Cancel leads.
///
/// Only the live identify exists so far. A chooser opened again from a saved `CHOOSE_STATION` in
/// History or its notification (T47, T51) arrives with History (pieces 2 and 3), and Cancel then
/// returns to History instead of Home.
enum ChooserOrigin {
  /// The answer to the identify the listener just made (T19′): Cancel goes Home (T46).
  liveIdentify,
}
