/// Where the account gate was opened from, which decides where "Not now" leads (ADR-005, design §3.2).
enum AccountGateOrigin {
  /// A live identify just answered `ACCOUNT_REQUIRED`: "Not now" goes Home.
  liveIdentify,

  /// A History row "Sign up to see this result" (or its notification): "Not now" goes back to History.
  savedRecognition,
}
