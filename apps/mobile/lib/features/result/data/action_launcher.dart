import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// Opens a button's address in the app that handles it: the dialler, WhatsApp, Google Maps or the
/// browser (design §3.14). An interface, so the Result screen never touches `url_launcher` itself
/// and tests can record what would have been opened.
abstract interface class ActionLauncher {
  /// Opens [address], an address `buildActionUri` made. Resolves to true when the phone opened it
  /// and to false when it could not (no app for it, or the platform refused), so the screen can
  /// offer to copy it instead (S4-D19). Never throws for a failure to open.
  Future<bool> open(String address);
}

/// The shape of `url_launcher`'s `launchUrl`, as far as the app uses it.
typedef UrlOpener = Future<bool> Function(Uri address, {LaunchMode mode});

/// Opens addresses with `url_launcher` 6.3.3, always in an external application (S4-LINKS-10): the
/// app has no web view to secure, and phones without Google Play still open map and WhatsApp
/// addresses in the browser.
///
/// It never asks the platform beforehand whether an address can be opened: on Android 11 and later
/// that question answers "no" for anything missing from the manifest's queries, which would hide
/// working buttons. It simply tries, and treats a refusal as "couldn't open".
final class UrlLauncherActionLauncher implements ActionLauncher {
  /// [openUrl] is `url_launcher`'s `launchUrl`; a test passes its own to see the call it gets.
  const UrlLauncherActionLauncher({UrlOpener openUrl = launchUrl}) : _openUrl = openUrl;

  final UrlOpener _openUrl;

  @override
  Future<bool> open(String address) async {
    try {
      return await _openUrl(Uri.parse(address), mode: LaunchMode.externalApplication);
    } on Exception {
      // A `PlatformException` (no handler, or the platform refused), a missing plugin, or an
      // address that will not parse: all mean the phone could not open it, which the screen
      // answers with the copy sheet. Programming errors (`Error`s) still reach the global handler.
      return false;
    }
  }
}

/// The launcher the Result screen uses; tests override it with a recording fake (design §3.5).
final Provider<ActionLauncher> actionLauncherProvider = Provider<ActionLauncher>(
  (ref) => const UrlLauncherActionLauncher(),
);
