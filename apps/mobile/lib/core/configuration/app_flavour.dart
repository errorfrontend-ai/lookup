/// Which build of the app this is. The names are the Android product flavours in
/// android/app/build.gradle.kts and the values of `LOOKUP_FLAVOUR`, so the two can be compared at
/// start-up and a build that mixes them refuses to run (design §3.7, S4-D25).
enum AppFlavour {
  /// The emulator and the developer's phone: the only build that may send plain `http` (to the PC)
  /// or switch on error details, developer tools and verbose logs.
  development,

  /// The staging server, built the same way as production.
  staging,

  /// What listeners install.
  production;

  /// The flavour with exactly this name, or null when the name is missing or unknown, so an unknown
  /// value can never fall back to a looser flavour.
  static AppFlavour? fromName(String name) {
    for (final flavour in values) {
      if (flavour.name == name) return flavour;
    }
    return null;
  }
}
