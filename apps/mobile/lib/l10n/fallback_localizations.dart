import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'app_localizations.dart';

/// The localisation delegates the app installs (design §3.17, P6-D22, P6-LOCALISATION-03): the
/// app's own words from the ARB files, Flutter's Material, Cupertino and widgets texts, and, last,
/// English Material and Cupertino texts for a language Flutter ships none for.
///
/// Flutter's own delegates know about 80 languages, and Bemba (`bem`) and Nyanja (`ny`) are not
/// among them. Without these fallbacks, adding `app_bem.arb` would give a Bemba screen with no
/// Material texts at all (the Back button's tooltip, the date picker, a text field's menu), and
/// Flutter would refuse to build it. With them, an ARB file alone adds a language: the app's words
/// in that language, Flutter's few words in English.
abstract final class FallbackLocalizations {
  /// The language whose Material and Cupertino texts stand in for an unsupported one.
  static const Locale fallbackLocale = Locale('en');

  /// What `MaterialApp.localizationsDelegates` gets. For each kind of text Flutter uses the first
  /// delegate that supports the locale, so the fallbacks after the real delegates are used only
  /// for a language the real ones do not support.
  static const List<LocalizationsDelegate<Object?>> delegates = [
    ...AppLocalizations.localizationsDelegates,
    FallbackMaterialLocalizationsDelegate(),
    FallbackCupertinoLocalizationsDelegate(),
  ];

  /// The app's languages: exactly those with an ARB file.
  static const List<Locale> supportedLocales = AppLocalizations.supportedLocales;
}

/// English Material texts for a language `GlobalMaterialLocalizations` does not support.
final class FallbackMaterialLocalizationsDelegate
    extends LocalizationsDelegate<MaterialLocalizations> {
  const FallbackMaterialLocalizationsDelegate();

  @override
  bool isSupported(Locale locale) => !GlobalMaterialLocalizations.delegate.isSupported(locale);

  @override
  Future<MaterialLocalizations> load(Locale locale) =>
      GlobalMaterialLocalizations.delegate.load(FallbackLocalizations.fallbackLocale);

  @override
  bool shouldReload(FallbackMaterialLocalizationsDelegate old) => false;
}

/// English Cupertino texts for a language `GlobalCupertinoLocalizations` does not support.
final class FallbackCupertinoLocalizationsDelegate
    extends LocalizationsDelegate<CupertinoLocalizations> {
  const FallbackCupertinoLocalizationsDelegate();

  @override
  bool isSupported(Locale locale) => !GlobalCupertinoLocalizations.delegate.isSupported(locale);

  @override
  Future<CupertinoLocalizations> load(Locale locale) =>
      GlobalCupertinoLocalizations.delegate.load(FallbackLocalizations.fallbackLocale);

  @override
  bool shouldReload(FallbackCupertinoLocalizationsDelegate old) => false;
}

/// The app's words for a place that may sit above the app's localisations: Flutter's error
/// fallback can be built anywhere, so it reads the words when they are there and English otherwise.
extension AppLocalizationsOrEnglish on BuildContext {
  /// The app's words in the listener's language, or English when none are installed above.
  AppLocalizations get appWordsOrEnglish =>
      Localizations.of<AppLocalizations>(this, AppLocalizations) ??
      lookupAppLocalizations(FallbackLocalizations.fallbackLocale);
}
